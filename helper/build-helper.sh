#!/usr/bin/env bash
#
# Compile the Swift Vision helper as a universal (arm64 + x86_64) release binary
# and place it where the Tauri bundler picks it up as a bundled resource.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/vision-bg-remove.swift"
OUT="$ROOT/../src-tauri/binaries/vision-bg-remove"

mkdir -p "$(dirname "$OUT")"

echo "==> Compiling Swift Vision helper (universal binary)…"
swiftc -O \
  -target arm64-apple-macos14.0 \
  -o "$OUT.arm64" \
  "$SRC"

# Build an x86_64 slice too so the .app runs on Intel Macs.
if swiftc -O \
    -target x86_64-apple-macos14.0 \
    -o "$OUT.x86_64" \
    "$SRC" 2>/dev/null; then
  lipo -create -output "$OUT" "$OUT.arm64" "$OUT.x86_64"
  rm -f "$OUT.arm64" "$OUT.x86_64"
  echo "==> Built universal binary: $OUT"
else
  # No x86_64 SDK slice available — fall back to arm64-only.
  mv "$OUT.arm64" "$OUT"
  rm -f "$OUT.x86_64"
  echo "==> Built arm64 binary (x86_64 slice unavailable): $OUT"
fi

chmod +x "$OUT"
lipo -info "$OUT" 2>/dev/null || true
