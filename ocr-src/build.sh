#!/bin/bash
# bin/ocr のビルド(SwiftPM 不使用の単純ビルド)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin
swiftc -O ocr-src/main.swift -o bin/ocr -framework Vision -framework AppKit -framework EventKit
echo "built: bin/ocr"
