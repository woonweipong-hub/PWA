"""
Bumps the versionCode in an AAB's base/manifest/AndroidManifest.xml (binary AXML).
Usage: python bump_aab_version.py <input.aab> <output.aab> <new_version_code>
"""
import sys
import zipfile
import shutil
import struct
import os

def find_and_replace_version_code(data: bytes, new_code: int) -> bytes:
    """
    In binary AXML, versionCode appears as a 4-byte little-endian int.
    It is preceded by its attribute name resource ID 0x0101021b.
    We locate that resource ID and replace the value 4 bytes after the
    value-data field offset.
    """
    RES_ID = b'\x1b\x02\x01\x01'  # 0x0101021b little-endian
    idx = 0
    replacements = 0
    out = bytearray(data)
    while True:
        pos = data.find(RES_ID, idx)
        if pos == -1:
            break
        # In AXML attribute structure (20 bytes):
        # [ns(4)][name(4)][rawValue(4)][valueSize(2)][res0(1)][dataType(1)][data(4)]
        # resId is at name position; the data field is 12 bytes after resId start
        val_pos = pos + 12
        if val_pos + 4 <= len(data):
            old_code = struct.unpack_from('<I', data, val_pos)[0]
            print(f"  Found versionCode={old_code} at offset {val_pos}, replacing with {new_code}")
            struct.pack_into('<I', out, val_pos, new_code)
            replacements += 1
        idx = pos + 4
    return bytes(out), replacements

def bump_version_code(input_aab: str, output_aab: str, new_code: int):
    shutil.copy2(input_aab, output_aab)
    manifest_path = "base/manifest/AndroidManifest.xml"
    
    # Read the manifest from the AAB
    with zipfile.ZipFile(input_aab, 'r') as zin:
        if manifest_path not in zin.namelist():
            print(f"ERROR: {manifest_path} not found in AAB. Contents:")
            for n in zin.namelist()[:20]:
                print(f"  {n}")
            sys.exit(1)
        manifest_data = zin.read(manifest_path)
    
    new_manifest, count = find_and_replace_version_code(manifest_data, new_code)
    if count == 0:
        print("WARNING: versionCode attribute not found via resource ID. Trying fallback...")
        sys.exit(1)
    
    # Write back into the copy
    import tempfile
    tmp = output_aab + ".tmp"
    with zipfile.ZipFile(output_aab, 'r') as zin:
        with zipfile.ZipFile(tmp, 'w', compression=zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == manifest_path:
                    zout.writestr(item, new_manifest)
                else:
                    zout.writestr(item, zin.read(item.filename))
    os.replace(tmp, output_aab)
    print(f"Done. {count} replacement(s). Saved to: {output_aab}")

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python bump_aab_version.py <input.aab> <output.aab> <new_version_code>")
        sys.exit(1)
    bump_version_code(sys.argv[1], sys.argv[2], int(sys.argv[3]))
