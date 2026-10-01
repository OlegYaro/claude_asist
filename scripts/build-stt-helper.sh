#!/usr/bin/env bash
# Сборка нативного хелпера распознавания речи.
#
# Требует Xcode Command Line Tools (swiftc). Результат — один бинарь без
# внешних зависимостей, который electron-builder кладёт в Resources приложения.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/native/stt-helper/main.swift"
OUT="$ROOT/resources/stt-helper"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "Ошибка: не найден swiftc. Установите Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

# Явный таргет macOS 26: Speech framework (SpeechAnalyzer/SpeechTranscriber)
# доступен только начиная с неё, и без указания версии компилятор ругается
# на использование этих API.
swiftc -O \
  -target arm64-apple-macos26.0 \
  -framework Speech \
  -framework AVFoundation \
  -o "$OUT" \
  "$SRC"

echo "Собрано: $OUT"
