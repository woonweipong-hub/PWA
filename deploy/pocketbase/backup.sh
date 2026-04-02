#!/bin/bash
# SiteShrimp — Automated PocketBase Backup Script
# Backs up PocketBase data (SQLite DB + uploaded files) to Google Drive
#
# Prerequisites:
#   1. PocketBase running at /opt/siteshrimp (setup.sh done)
#   2. rclone installed and configured with Google Drive remote named "gdrive"
#
# Setup (run once on the VM):
#   1. Install rclone:
#      curl https://rclone.org/install.sh | sudo bash
#
#   2. Configure Google Drive remote:
#      rclone config
#      → New remote → name: gdrive → type: Google Drive → follow auth prompts
#
#   3. Install this script:
#      sudo cp backup.sh /opt/siteshrimp/backup.sh
#      sudo chmod +x /opt/siteshrimp/backup.sh
#
#   4. Add to crontab (runs daily at 2 AM):
#      sudo crontab -e
#      → Add: 0 2 * * * /opt/siteshrimp/backup.sh >> /var/log/siteshrimp-backup.log 2>&1
#
#   5. Test it:
#      sudo /opt/siteshrimp/backup.sh

set -e

# ====== CONFIG ======
PB_DIR="/opt/siteshrimp"
BACKUP_DIR="/tmp/siteshrimp-backups"
GDRIVE_REMOTE="gdrive:SiteShrimp-Backups"
RETENTION_DAYS=30
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="siteshrimp-backup-${DATE}.tar.gz"
# ====================

echo ""
echo "=== SiteShrimp Backup — ${DATE} ==="

# 1. Create backup directory
mkdir -p "$BACKUP_DIR"

# 2. Create a safe copy of PocketBase data
#    Using SQLite .backup command for consistency (avoids corruption from hot copy)
echo "Creating SQLite backup..."
if command -v sqlite3 &> /dev/null; then
  sqlite3 "$PB_DIR/pb_data/data.db" ".backup '$BACKUP_DIR/data.db'"
else
  # Fallback: copy files directly (less safe if PB is writing)
  echo "Warning: sqlite3 not found. Using file copy (less safe)."
  cp "$PB_DIR/pb_data/data.db" "$BACKUP_DIR/data.db"
fi

# 3. Copy uploaded files (photos, documents)
echo "Copying uploaded files..."
if [ -d "$PB_DIR/pb_data/storage" ]; then
  cp -r "$PB_DIR/pb_data/storage" "$BACKUP_DIR/storage"
fi

# 4. Compress everything
echo "Compressing to ${BACKUP_FILE}..."
tar czf "$BACKUP_DIR/$BACKUP_FILE" \
  -C "$BACKUP_DIR" \
  data.db \
  $([ -d "$BACKUP_DIR/storage" ] && echo "storage")

# 5. Upload to Google Drive
echo "Uploading to Google Drive..."
if command -v rclone &> /dev/null; then
  rclone copy "$BACKUP_DIR/$BACKUP_FILE" "$GDRIVE_REMOTE/" --progress
  echo "Uploaded: $GDRIVE_REMOTE/$BACKUP_FILE"

  # 6. Clean up old backups on Drive (keep last N days)
  echo "Cleaning old backups (keeping ${RETENTION_DAYS} days)..."
  rclone delete "$GDRIVE_REMOTE/" --min-age "${RETENTION_DAYS}d" 2>/dev/null || true
else
  echo "Warning: rclone not installed. Backup saved locally only."
  echo "Install rclone: curl https://rclone.org/install.sh | sudo bash"
  echo "Then configure: rclone config → New remote → gdrive → Google Drive"
fi

# 7. Clean up local temp files
rm -rf "$BACKUP_DIR/data.db" "$BACKUP_DIR/storage"

# Keep local backup for 3 days as safety net
find "$BACKUP_DIR" -name "siteshrimp-backup-*.tar.gz" -mtime +3 -delete 2>/dev/null || true

# 8. Show backup size
SIZE=$(du -h "$BACKUP_DIR/$BACKUP_FILE" 2>/dev/null | cut -f1)
echo ""
echo "=== Backup Complete ==="
echo "  File: $BACKUP_DIR/$BACKUP_FILE"
echo "  Size: $SIZE"
echo "  Drive: $GDRIVE_REMOTE/$BACKUP_FILE"
echo ""
