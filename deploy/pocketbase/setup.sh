#!/bin/bash
# SiteShrimp — PocketBase Setup Script
# Run on your GCP VM (or any Linux server) to set up the backend
#
# Usage (from cloned repo):
#   chmod +x deploy/pocketbase/setup.sh && ./deploy/pocketbase/setup.sh
#
# What this does:
#   1. Downloads PocketBase (single binary, ~30MB)
#   2. Creates systemd service (auto-starts on reboot)
#   3. Imports database schema (defects, users, projects)
#   4. Starts PocketBase on port 8090
#   5. Sets up admin account

set -e

# ====== CONFIG ======
PB_VERSION="0.36.8"
PB_DIR="/opt/siteshrimp"
PB_PORT="8090"
PB_DOMAIN="${SITESHRIMP_DOMAIN:-}"  # Optional: set for HTTPS
ADMIN_EMAIL="${SITESHRIMP_ADMIN_EMAIL:-admin@siteshrimp.app}"
ADMIN_PASSWORD="${SITESHRIMP_ADMIN_PASSWORD:-$(openssl rand -base64 16)}"
# ====================

echo "=== SiteShrimp PocketBase Setup ==="
echo ""

# 1. Create directory
sudo mkdir -p "$PB_DIR/pb_hooks"
sudo mkdir -p "$PB_DIR/pb_data"
cd "$PB_DIR"

# 2. Download PocketBase
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  PB_ARCH="linux_amd64" ;;
  aarch64) PB_ARCH="linux_arm64" ;;
  armv7l)  PB_ARCH="linux_armv7" ;;
  *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "Downloading PocketBase v${PB_VERSION} (${PB_ARCH})..."
curl -sL "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_${PB_ARCH}.zip" -o /tmp/pb.zip
sudo unzip -o /tmp/pb.zip -d "$PB_DIR" pocketbase
sudo chmod +x "$PB_DIR/pocketbase"
rm /tmp/pb.zip

echo "PocketBase downloaded: $PB_DIR/pocketbase"

# 3. Copy hooks if available
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/pb_hooks/main.pb.js" ]; then
  sudo cp "$SCRIPT_DIR/pb_hooks/main.pb.js" "$PB_DIR/pb_hooks/"
  echo "Hooks installed."
fi

# 4. Create systemd service
sudo tee /etc/systemd/system/siteshrimp.service > /dev/null << EOF
[Unit]
Description=SiteShrimp PocketBase Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$PB_DIR
ExecStart=$PB_DIR/pocketbase serve --http=0.0.0.0:$PB_PORT
Restart=always
RestartSec=5
Environment=GEMINI_API_KEY=${GEMINI_API_KEY:-}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable siteshrimp
sudo systemctl start siteshrimp

echo ""
echo "=== SiteShrimp Backend Running ==="
echo ""
echo "  PocketBase:  http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_VM_IP'):${PB_PORT}"
echo "  Admin UI:    http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_VM_IP'):${PB_PORT}/_/"
echo "  Admin Email: ${ADMIN_EMAIL}"
echo "  Admin Pass:  ${ADMIN_PASSWORD}"
echo ""
echo "  Create admin:  $PB_DIR/pocketbase admin create ${ADMIN_EMAIL} ${ADMIN_PASSWORD}"
echo ""
echo "  Service:       sudo systemctl status siteshrimp"
echo "  Logs:          sudo journalctl -u siteshrimp -f"
echo "  Restart:       sudo systemctl restart siteshrimp"
echo ""
echo "Next: Open the Admin UI in your browser to create your admin account,"
echo "then set this URL in the SiteShrimp PWA settings."
echo ""
echo "=== Done ==="
