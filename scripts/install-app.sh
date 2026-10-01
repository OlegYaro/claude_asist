#!/usr/bin/env bash
# Устанавливает собранное приложение в /Applications, чтобы запускать его по иконке
# из Launchpad, Spotlight или Dock.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="Claude Voice Desk.app"
SRC="$ROOT/dist/mac-arm64/$NAME"
DEST="/Applications/$NAME"

if [ ! -d "$SRC" ]; then
  echo "Нет сборки: $SRC — сначала electron-builder --mac --arm64 --dir" >&2
  exit 1
fi

# Запущенную копию закрываем, иначе замена файлов сломает работающий процесс.
osascript -e 'tell application id "com.krip.claude-voice-desk" to quit' >/dev/null 2>&1 || true

rm -rf "$DEST"
ditto "$SRC" "$DEST"
# Собрано локально, но атрибут карантина мог прийти из загруженных зависимостей.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
# Обновить иконку в Finder/Launchpad.
touch "$DEST"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true

echo "Установлено: $DEST"
