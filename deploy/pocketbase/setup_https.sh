#!/bin/bash
# SiteShrimp — HTTPS Setup with Caddy + DuckDNS
# Run AFTER setup.sh on the GCP VM
#
# Prerequisites:
#   1. PocketBase running on port 8090 (setup.sh done)
#   2. DuckDNS subdomain created and pointing to this VM's IP
#
# Usage:
#   DUCKDNS_DOMAIN=api.siteshrimp.org DUCKDNS_TOKEN=your-token ./setup_https.sh

set -e

DOMAIN="${DUCKDNS_DOMAIN:-api.siteshrimp.org}"
DUCKDNS_TOKEN="${DUCKDNS_TOKEN:-}"

echo "=== SiteShrimp HTTPS Setup ==="
echo "Domain: $DOMAIN"

# 1. Install Caddy
echo "Installing Caddy..."
sudo apt-get update -qq
sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq caddy

# 2. Configure Caddy as reverse proxy for PocketBase
sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
$DOMAIN {
    reverse_proxy localhost:8090
}
EOF

# 3. Restart Caddy (auto-provisions Let's Encrypt SSL)
sudo systemctl restart caddy
sudo systemctl enable caddy

# 4. Set up DuckDNS auto-update (keeps IP in sync)
if [ -n "$DUCKDNS_TOKEN" ]; then
  # Create update script
  sudo tee /opt/siteshrimp/duckdns_update.sh > /dev/null << DDEOF
#!/bin/bash
curl -s "https://www.duckdns.org/update?domains=${DOMAIN%.duckdns.org}&token=${DUCKDNS_TOKEN}&ip=" > /dev/null
DDEOF
  sudo chmod +x /opt/siteshrimp/duckdns_update.sh

  # Add cron job to update every 5 minutes
  (crontab -l 2>/dev/null; echo "*/5 * * * * /opt/siteshrimp/duckdns_update.sh") | crontab -
  echo "DuckDNS auto-update configured."
fi

echo ""
echo "=== HTTPS Setup Complete ==="
echo ""
echo "  Your backend is now at: https://$DOMAIN"
echo "  PocketBase Admin:       https://$DOMAIN/_/"
echo "  Caddy status:           sudo systemctl status caddy"
echo ""
echo "  Share this link with your team:"
echo "  https://siteshrimp.org/?api=https://$DOMAIN"
echo ""
echo "=== Done ==="
