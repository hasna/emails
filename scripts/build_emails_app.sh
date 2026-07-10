#!/usr/bin/env bash
# Build "Emails" — the WKWebView macOS shell hosting the web UI — and assemble a
# launchable .app bundle. Run ON a macOS 26 Mac (Command Line Tools, no Xcode).
#
# A copycat of open-notes' build_hasnanotes.sh, retargeted to Emails and with the AI
# sidecar dropped (Emails has no sidecar — it shells out to the `emails` CLI instead).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGET_NAME="EmailsApp"
APP_NAME="Emails"
EXEC_NAME="Emails"
BUNDLE_ID="com.hasna.emails"
DIST="$REPO_ROOT/dist"
APP="$DIST/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

echo "==> swift build -c release ($TARGET_NAME)"
swift build -c release --product "$TARGET_NAME"

BIN_PATH="$(swift build -c release --show-bin-path)"
BUILT_BINARY="$BIN_PATH/$TARGET_NAME"
[[ -f "$BUILT_BINARY" ]] || { echo "ERROR: binary not found at $BUILT_BINARY" >&2; exit 1; }

echo "==> Assembling $APP"
mkdir -p "$DIST"
rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$RESOURCES"
cp "$BUILT_BINARY" "$MACOS_DIR/$EXEC_NAME"
chmod +x "$MACOS_DIR/$EXEC_NAME"

# Bundle the web UI (offline assets) into Resources/web.
echo "==> Bundling web UI -> Resources/web"
rm -rf "$RESOURCES/web"
mkdir -p "$RESOURCES/web"
cp -R "$REPO_ROOT/web/." "$RESOURCES/web/"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleExecutable</key><string>$EXEC_NAME</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>LSMinimumSystemVersion</key><string>26.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

echo "==> Ad-hoc codesign"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP" && echo "   signature OK"

echo "BUILT: $APP"
echo "       (CFBundleName=\"$APP_NAME\", bundle id=$BUNDLE_ID, exec=$EXEC_NAME)"
