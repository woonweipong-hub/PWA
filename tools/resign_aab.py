"""
Patches versionCode in an AAB and re-signs it using JAR v1 signing (same as original).
Usage: python resign_aab.py <input.aab> <output.aab> <keystore.p12> <password> <alias> <new_version_code>
"""
import sys, os, zipfile, hashlib, base64, struct
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization.pkcs12 import load_key_and_certificates
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography import x509
from cryptography.hazmat.backends import default_backend
import email.generator, io

# ── helpers ──────────────────────────────────────────────────────────────────

def sha1_b64(data: bytes) -> str:
    return base64.b64encode(hashlib.sha1(data).digest()).decode()

def sha256_b64(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode()

def build_manifest(entries: dict) -> bytes:
    """Build META-INF/MANIFEST.MF"""
    lines = ["Manifest-Version: 1.0\r\n\r\n"]
    for name, data in entries.items():
        digest = sha1_b64(data)
        lines.append(f"Name: {name}\r\nSHA-256-Digest: {sha256_b64(data)}\r\nSHA1-Digest: {digest}\r\n\r\n")
    return "".join(lines).encode()

def build_sf(manifest_bytes: bytes, entries: dict) -> bytes:
    """Build META-INF/<alias>.SF"""
    mf_digest = sha1_b64(manifest_bytes)
    mf256_digest = sha256_b64(manifest_bytes)
    lines = [
        "Signature-Version: 1.0\r\n",
        f"SHA1-Digest-Manifest: {mf_digest}\r\n",
        f"SHA-256-Digest-Manifest: {mf256_digest}\r\n",
        "Created-By: resign_aab.py\r\n\r\n",
    ]
    # Per-entry digests are digests of the manifest section for that entry
    for name, data in entries.items():
        # Build the manifest section for this entry
        section = f"Name: {name}\r\nSHA-256-Digest: {sha256_b64(data)}\r\nSHA1-Digest: {sha1_b64(data)}\r\n\r\n"
        section_bytes = section.encode()
        lines.append(f"Name: {name}\r\nSHA1-Digest: {sha1_b64(section_bytes)}\r\nSHA-256-Digest: {sha256_b64(section_bytes)}\r\n\r\n")
    return "".join(lines).encode()

def build_pkcs7_signature(sf_bytes: bytes, private_key, cert) -> bytes:
    """Build a detached PKCS7/CMS signature block (RSA)."""
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization
    from cryptography.x509 import Certificate
    import struct

    # Use cryptography's PKCS7 SignedData builder if available (>=3.x)
    try:
        from cryptography.hazmat.primitives.serialization import pkcs7
        builder = pkcs7.PKCS7SignatureBuilder()
        builder = builder.set_data(sf_bytes)
        builder = builder.add_signer(cert, private_key, hashes.SHA256())
        return builder.sign(serialization.Encoding.DER, [pkcs7.PKCS7Options.DetachedSignature])
    except Exception as e:
        raise RuntimeError(f"PKCS7 signing failed: {e}")

# ── main ──────────────────────────────────────────────────────────────────────

def process(input_aab, output_aab, keystore_path, password, alias, new_version_code):
    pw = password.encode()

    # Load keystore
    with open(keystore_path, 'rb') as f:
        ks_data = f.read()

    try:
        private_key, cert, chain = load_key_and_certificates(ks_data, pw, default_backend())
    except Exception as e:
        print(f"ERROR loading keystore: {e}")
        print("Trying empty password...")
        private_key, cert, chain = load_key_and_certificates(ks_data, b'', default_backend())

    print(f"Loaded cert: {cert.subject}")

    # Read all entries from original AAB
    sig_exts = {'.sf', '.rsa', '.dsa', '.ec'}
    entries = {}
    with zipfile.ZipFile(input_aab, 'r') as z:
        for item in z.infolist():
            name_upper = item.filename.upper()
            # Skip old signature files
            if name_upper.startswith('META-INF/') and any(name_upper.endswith(e.upper()) for e in sig_exts):
                print(f"  Dropping old sig: {item.filename}")
                continue
            if name_upper == 'META-INF/MANIFEST.MF':
                continue
            data = z.read(item.filename)
            # Patch versionCode
            if item.filename == 'base/manifest/AndroidManifest.xml':
                # Patch 1: string value "1" -> new version string
                OLD_STR = b'versionCode\x1a\x011'
                NEW_STR = f'versionCode\x1a\x01{new_version_code}'.encode()
                if OLD_STR in data:
                    data = data.replace(OLD_STR, NEW_STR, 1)
                    print(f"  Patched versionCode string -> {new_version_code}")
                else:
                    print("  WARNING: versionCode string pattern not found")
                # Patch 2: compiled int_decimal_value (proto Prim field 6)
                # The unique context: resource ID for versionCode (0x0101021B) followed by Prim block
                # \x28\x9b\x84\x84\x08 = field5(resource_id=0x0101021B)
                # \x32\x04\x3a\x02\x30\x01 = field6, len4, Item{Prim{int_decimal=1}}
                OLD_INT = b'\x28\x9b\x84\x84\x08\x32\x04\x3a\x02\x30\x01'
                import struct
                new_vc_varint = bytes([int(new_version_code)])  # works for values 1-127
                NEW_INT = b'\x28\x9b\x84\x84\x08\x32\x04\x3a\x02\x30' + new_vc_varint
                if OLD_INT in data:
                    data = data.replace(OLD_INT, NEW_INT, 1)
                    print(f"  Patched versionCode compiled int -> {new_version_code}")
                else:
                    print("  WARNING: compiled versionCode int pattern not found")
            entries[item.filename] = (item, data)

    # Entries to sign (everything except META-INF itself)
    signable = {k: v[1] for k, v in entries.items() if not k.startswith('META-INF/')}

    print(f"Building MANIFEST.MF over {len(signable)} entries...")
    mf = build_manifest(signable)
    print(f"Building .SF...")
    sf = build_sf(mf, signable)
    print(f"Signing .SF with RSA/SHA256...")
    sig_block = build_pkcs7_signature(sf, private_key, cert)

    alias_upper = alias.upper().replace('-', '-')

    # Write new AAB
    print(f"Writing {output_aab}...")
    with zipfile.ZipFile(output_aab, 'w', compression=zipfile.ZIP_DEFLATED) as zout:
        # Write all original entries
        for name, (item, data) in entries.items():
            zout.writestr(item, data)
        # Write new signature files
        zout.writestr(f'META-INF/MANIFEST.MF', mf)
        zout.writestr(f'META-INF/{alias_upper}.SF', sf)
        zout.writestr(f'META-INF/{alias_upper}.RSA', sig_block)

    size_mb = os.path.getsize(output_aab) / 1024 / 1024
    print(f"Done! {output_aab} ({size_mb:.2f} MB)")

if __name__ == '__main__':
    if len(sys.argv) != 7:
        print("Usage: python resign_aab.py <input.aab> <output.aab> <keystore.p12> <password> <alias> <new_version_code>")
        sys.exit(1)
    process(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])
