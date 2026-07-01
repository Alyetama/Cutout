#!/usr/bin/env bash
#
# Build Cutout, ad-hoc sign it, and install it to /Applications.
#
# Steps:
#   1. Compile the Swift Vision helper (universal binary) into src-tauri/binaries.
#   2. Build the release .app with Tauri's bundler.
#   3. Ad-hoc sign, strip quarantine attrs, and copy to /Applications.
#
# The Tauri bundler shells out to `xattr` by name. If a non-Apple `xattr`
# (e.g. the miniforge/conda shim) is first on PATH, that step errors and aborts
# the bundle (including the .dmg). We prepend /usr/bin so the system xattr wins,
# and still tolerate a non-zero exit as a fallback (the .app is built first).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Cutout.app"
BUNDLE="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME"
DEST="/Applications/$APP_NAME"

echo "==> Compiling Swift Vision helper…"
bash "$ROOT/helper/build-helper.sh"

echo "==> Building release bundle…"
( cd "$ROOT" && PATH="/usr/bin:$PATH" npm run tauri build ) \
  || echo "   (bundler returned non-zero — continuing if the .app was built)"

if [ ! -d "$BUNDLE" ]; then
  echo "!! Build did not produce $BUNDLE" >&2
  exit 1
fi

echo "==> Stripping extended attributes (system xattr)…"
/usr/bin/xattr -cr "$BUNDLE"

echo "==> Ad-hoc signing (deep)…"
# Sign the bundled helper first, then the app, so the whole bundle validates.
/usr/bin/codesign --force --sign - --timestamp=none \
  "$BUNDLE/Contents/Resources/vision-bg-remove" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - --timestamp=none "$BUNDLE"
/usr/bin/codesign --verify --strict "$BUNDLE" && echo "   signature OK"

echo "==> Installing to /Applications…"
[ -d "$DEST" ] && rm -rf "$DEST"
cp -R "$BUNDLE" "$DEST"
/usr/bin/xattr -cr "$DEST"

echo ""
echo "✅ Installed $DEST"
echo "   First launch: right-click Cutout in /Applications → Open, then confirm"
echo "   (Gatekeeper flags it because it's ad-hoc signed, not notarized)."
