#!/usr/bin/env bash
# sync-assets.sh
# Copies the orcessa web app into the Android project's assets/www/ folder.
# Run after changing any web-side file (index.html, src/, styles.css, vendor/,
# soundfonts/) so the next APK build picks up the change.
#
# Usage:
#   cd android && ./sync-assets.sh
#   (or from the repo root: ./android/sync-assets.sh)
#
# Idempotent: wipes and re-copies assets/www/ each run so deletions propagate.

set -euo pipefail

# Resolve the repo root regardless of where this is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$SCRIPT_DIR/app/src/main/assets/www"

echo "Syncing web app → $DEST"
echo "Source: $REPO_ROOT"

mkdir -p "$DEST"
rm -rf "$DEST"/* "$DEST"/.[!.]* 2>/dev/null || true

# Copy only the web app — exclude Android, dotfiles, the local server helper,
# and the README (not part of the runtime web app).
for item in index.html styles.css src soundfonts vendor; do
  if [ -e "$REPO_ROOT/$item" ]; then
    cp -r "$REPO_ROOT/$item" "$DEST/"
  else
    echo "  WARN: $item not found in repo root, skipping."
  fi
done

COUNT=$(find "$DEST" -type f | wc -l | tr -d ' ')
SIZE=$(du -sh "$DEST" | cut -f1)
echo "Done. $COUNT files, $SIZE."
echo "Remember: bump android/app/build.gradle.kts versionCode so AssetCopier re-copies on update."
