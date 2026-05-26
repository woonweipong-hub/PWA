# Oracle VM Setup — Moondream 2 on Ollama (Phase 1)

Step-by-step to stand up `ai.siteshrimp.org` on Oracle Ampere A1 Always Free, serving the Moondream 2 vision model via Ollama, fronted by Caddy with TLS.

Assumes you have an Oracle Cloud account (user `woonwei.pong` per project memory) and your DNS for `siteshrimp.org` is on Cloudflare.

## 1. Create the VM

In the Oracle Cloud Console:

1. **Compute → Instances → Create instance**
2. Name: `siteshrimp-ai`
3. Shape: **VM.Standard.A1.Flex** (Ampere) — Always Free eligible
4. Allocate: **4 OCPU / 24 GB memory** (maximum within Always Free)
5. OS: **Canonical Ubuntu 22.04**
6. Boot volume: **50 GB** (Always Free includes 200 GB total block storage; this leaves headroom)
7. Networking: place in the default VCN's public subnet. Assign a public IPv4.
8. SSH: upload your public key (`~/.ssh/id_ed25519.pub` or equivalent).
9. **Create**.

Note the assigned public IP. Default user is `ubuntu`.

## 2. Open the firewall

Two layers — Oracle's VCN security list AND the instance's `iptables`.

### VCN security list

In **Networking → Virtual Cloud Networks → \<your VCN\> → Subnet → Default Security List**, add ingress rules:

| Source | Protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Leave SSH (`22`) restricted to your office / home IP if possible.

### Instance iptables

Ubuntu Ampere images ship with a default DROP policy. SSH in and:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Install Ollama

```bash
ssh ubuntu@<public-ip>
curl -fsSL https://ollama.com/install.sh | sh
```

Pull the model:

```bash
ollama pull moondream
```

Confirm:

```bash
ollama list
# Expected: moondream:latest ... ~1.7 GB
```

Test inference locally:

```bash
ollama run moondream "What is in this image?" < /dev/null
# Expect a reply within a few seconds. (No image attached here — just a smoke test.)
```

## 4. Configure Ollama to listen on a private interface

By default Ollama binds to `127.0.0.1:11434`. Keep it that way — Caddy will be the only thing talking to it, so the model server is never exposed directly.

Verify:

```bash
ss -tlnp | grep 11434
# Expected: 127.0.0.1:11434 LISTEN
```

If it's bound to `0.0.0.0` for some reason, fix in the systemd unit at `/etc/systemd/system/ollama.service.d/override.conf`:

```
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
```

Then `sudo systemctl daemon-reload && sudo systemctl restart ollama`.

## 5. Set up DNS

In Cloudflare DNS for `siteshrimp.org`, add an **A record**:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `ai` | `<your-vm-public-ip>` | **DNS only** (grey cloud) |

Critical: **grey cloud, not orange**. Caddy needs to do its own TLS challenge with Let's Encrypt; Cloudflare's proxy interferes.

Wait until `dig ai.siteshrimp.org` resolves to your VM IP before proceeding.

## 6. Install Caddy as reverse proxy

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Replace `/etc/caddy/Caddyfile` with:

```caddyfile
ai.siteshrimp.org {
    encode gzip
    reverse_proxy 127.0.0.1:11434 {
        header_up Host {http.reverse_proxy.upstream.hostport}
    }

    # Keep timeouts generous — CPU inference can take a few seconds
    request_body {
        max_size 20MB
    }

    log {
        output file /var/log/caddy/ai-access.log
    }
}
```

Then:

```bash
sudo systemctl reload caddy
sudo systemctl status caddy
```

Test from your laptop:

```bash
curl https://ai.siteshrimp.org/api/tags
# Expected JSON listing 'moondream' as an installed model.
```

If Let's Encrypt complains, check that ports 80 and 443 are open and the A record is propagated.

## 7. Keep-alive cron (prevent Always Free reclamation)

Oracle reclaims VMs that look idle. Even constant inbound traffic from Caddy may not register. Add a cron job that hits the local Ollama every 5 minutes to generate a tiny pulse of load:

```bash
sudo crontab -e
```

Append:

```
*/5 * * * * curl -s -X POST http://127.0.0.1:11434/api/tags > /dev/null
```

This is cheap (~1 ms response) but counts as VM activity from Oracle's perspective.

## 8. Pre-warm at boot

First request after a reboot is slow because Ollama loads the model into memory on demand. Pre-warm via a `systemd` drop-in:

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/prewarm.conf >/dev/null <<'EOF'
[Service]
ExecStartPost=/bin/bash -c 'sleep 5 && curl -s -X POST http://127.0.0.1:11434/api/generate -d "{\"model\":\"moondream\",\"prompt\":\"hi\",\"stream\":false}" > /dev/null'
EOF
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

After boot, the model stays warm. First real request from the app is fast.

## 9. Wire PocketBase to the new endpoint

On the **GCP** VM (`sitesnag` in `asia-southeast1-c`, install at `/opt/sitesnag/` per project memory) — NOT the new Oracle VM — set the env vars PocketBase reads:

```bash
sudo systemctl edit sitesnag
```

In the override editor:

```
[Service]
Environment="OLLAMA_URL=https://ai.siteshrimp.org"
Environment="OLLAMA_MODEL=moondream"
Environment="AI_DEFAULT_DAILY_CAP=100"
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart sitesnag
journalctl -u sitesnag -f | grep -i ollama
# Expected: no errors. PocketBase picks up the env vars on next AI call.
```

## 10. Smoke test from a client

Once Phase 1 client code lands and is deployed, the smoke test path is:

1. Open SiteShrimp in a fresh browser profile (no localStorage).
2. Settings → AI Setup. Confirm the banner shows *"Using SiteShrimp default AI (Moondream 2)"*.
3. LOG a defect with a photo. Watch the form prefill within a few seconds.
4. On the Oracle VM: `sudo journalctl -u ollama -f` should show one request landing.
5. On the GCP VM: `journalctl -u sitesnag -f` should show one `/api/ai/analyze` request.

## Operational notes

- **Daily cap**: `AI_DEFAULT_DAILY_CAP` is per authenticated user per UTC day. In-memory in PocketBase, resets on restart.
- **Monitoring**: `caddy` access log at `/var/log/caddy/ai-access.log`. Volume should be small in Phase 1.
- **Updating Moondream**: `ollama pull moondream` again — Ollama handles atomic swap.
- **Adding a fine-tuned variant later (Phase 4)**: `ollama create moondream-ft -f Modelfile`; set `OLLAMA_MODEL=moondream-ft` on the GCP VM; restart `sitesnag`. App code unchanged.

## Rollback

If the Oracle endpoint misbehaves and you want to disable the SiteShrimp default:

```bash
# On the GCP VM
sudo systemctl edit sitesnag
# Remove the OLLAMA_URL line, save.
sudo systemctl daemon-reload && sudo systemctl restart sitesnag
```

The `/api/ai/analyze` endpoint will now return a clear error, and the client dispatcher falls back to telling the user to set up their own AI provider — exactly the pre-Phase-1 behaviour.
