#!/bin/bash
# SiteShrimp — Restore PocketBase from Backup
#
# Usage:
#   ./restore.sh                              # Restore latest backup from Google Drive
#   ./restore.sh siteshrimp-backup-20260402.tar.gz  # Restore specific file
#   ./restore.sh /path/to/local/backup.tar.gz       # Restore from local file

set -e

PB_DIR="/opt/siteshrimp"
GDRIVE_REMOTE="gdrive:SiteShrimp-Backups"
RESTORE_DIR="/tmp/siteshrimp-restore"

echo "=== SiteShrimp Restore ==="

# Determine backup source
BACKUP_FILE="$1"

if [ -z "$BACKUP_FILE" ]; then
  echo "Fetching latest backup from Google Drive..."
  mkdir -p "$RESTORE_DIR"
  LATEST=$(rclone lsf "$GDRIVE_REMOTE/" --files-only | sort | tail -1)
  if [ -z "$LATEST" ]; then
    echo "Error: No backups found on Google Drive."
    exit 1
  fi
  echo "Latest: $LATEST"
  rclone copy "$GDRIVE_REMOTE/$LATEST" "$RESTORE_DIR/" --progress
  BACKUP_FILE="$RESTORE_DIR/$LATEST"
elif [ ! -f "$BACKUP_FILE" ]; then
  # Try as a filename on Drive
  mkdir -p "$RESTORE_DIR"
  echo "Downloading $BACKUP_FILE from Drive..."
  rclone copy "$GDRIVE_REMOTE/$BACKUP_FILE" "$RESTORE_DIR/" --progress
  BACKUP_FILE="$RESTORE_DIR/$BACKUP_FILE"
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "Backup file: $BACKUP_FILE"
echo ""
echo "WARNING: This will stop PocketBase and replace all data."
read -p "Continue? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Cancelled."
  exit 0
fi

# 1. Stop PocketBase
echo "Stopping PocketBase..."
sudo systemctl stop siteshrimp 2>/dev/null || true
sleep 2

# 2. Backup current data (safety net)
SAFETY="$PB_DIR/pb_data.pre-restore.$(date +%Y%m%d_%H%M%S)"
echo "Safety backup of current data: $SAFETY"
sudo cp -r "$PB_DIR/pb_data" "$SAFETY"

# 3. Extract backup
echo "Extracting backup..."
mkdir -p "$RESTORE_DIR/extracted"
tar xzf "$BACKUP_FILE" -C "$RESTORE_DIR/extracted"

# 4. Restore database
echo "Restoring database..."
sudo cp "$RESTORE_DIR/extracted/data.db" "$PB_DIR/pb_data/data.db"

# 5. Restore uploaded files
if [ -d "$RESTORE_DIR/extracted/storage" ]; then
  echo "Restoring uploaded files..."
  sudo rm -rf "$PB_DIR/pb_data/storage"
  sudo cp -r "$RESTORE_DIR/extracted/storage" "$PB_DIR/pb_data/storage"
fi

# 6. Restart PocketBase
echo "Starting PocketBase..."
sudo systemctl start siteshrimp
sleep 2
sudo systemctl status siteshrimp --no-pager || true

# 7. Clean up
rm -rf "$RESTORE_DIR"

echo ""
echo "=== Restore Complete ==="
echo "  Safety backup: $SAFETY"
echo "  PocketBase restarted."
echo ""
