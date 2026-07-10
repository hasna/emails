#!/usr/bin/env bash
# Sync this repo to a macOS Mac and build the Emails .app there. Run from spark02/spark01.
#
# A copycat of open-notes' run_on_apple03.sh. Defaults to apple03; override with
# REMOTE_HOST. Also runs the Swift smoke harness (EmailsSmoke) on the Mac first so a
# broken core fails fast before assembling the bundle.
#
#   REMOTE_HOST=apple03 bash scripts/run_on_apple_mac.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-apple03}"
REMOTE_PATH="${REMOTE_PATH:-/Users/hasna/Workspace/hasna/opensource/open-emails}"

echo "==> rsync $REPO_ROOT -> $REMOTE_HOST:$REMOTE_PATH"
ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_PATH'"
rsync -az --delete \
  --exclude '.git/' \
  --exclude '.build/' \
  --exclude 'dist/' \
  --exclude 'node_modules/' \
  "$REPO_ROOT/" "$REMOTE_HOST:$REMOTE_PATH/"

echo "==> smoke test on $REMOTE_HOST (EmailsSmoke)"
ssh "$REMOTE_HOST" "cd '$REMOTE_PATH' && swift run -c release EmailsSmoke"

echo "==> building on $REMOTE_HOST"
ssh "$REMOTE_HOST" "cd '$REMOTE_PATH' && bash scripts/build_emails_app.sh"

echo ""
echo "Done. App built at $REMOTE_HOST:$REMOTE_PATH/dist/Emails.app"
