#!/usr/bin/env bash
# Собирает build/icon.icns из scripts/make-icon.swift (нужны только swift, sips, iconutil).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

swift "$ROOT/scripts/make-icon.swift" "$TMP/icon.png" >/dev/null

SET="$TMP/icon.iconset"
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$TMP/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$ROOT/build/icon.icns"
cp "$TMP/icon.png" "$ROOT/build/icon.png"
echo "Собрано: build/icon.icns"
