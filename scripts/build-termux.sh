#!/usr/bin/env bash
# Build native triviumdb.android-arm64.node directly inside Termux (Android Bionic aarch64)
# Usage inside Termux:
#   bash scripts/build-termux.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$EXT_DIR/native"
TRIVIUM_VER="${TRIVIUM_VER:-v0.9.0}"

echo "=== TriviumDB Native Addon Builder for Termux ==="
echo "Extension dir: $EXT_DIR"
echo "Target version: $TRIVIUM_VER"

if command -v pkg >/dev/null 2>&1; then
    echo "[1/4] Checking Termux packages (rust, nodejs, git, clang, make)..."
    pkg install -y rust nodejs git clang make
fi

TMP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/triviumdb-build.XXXXXX")"
trap 'rm -rf "$TMP_BUILD"' EXIT

echo "[2/4] Cloning YoKONCy/TriviumDB ($TRIVIUM_VER)..."
git clone --depth 1 --branch "$TRIVIUM_VER" https://github.com/YoKONCy/TriviumDB.git "$TMP_BUILD/TriviumDB"
cd "$TMP_BUILD/TriviumDB"

echo "[3/4] Compiling Rust cdylib with --features nodejs (release)..."
cargo build --release --features nodejs

SO_PATH="target/release/libtriviumdb.so"
if [[ ! -f "$SO_PATH" ]]; then
    echo "ERROR: Expected $SO_PATH was not produced!" >&2
    exit 1
fi

ARCH="$(node -p 'process.arch')"
PLATFORM="$(node -p 'process.platform')"
OUT_PRIMARY="$NATIVE_DIR/triviumdb.${PLATFORM}-${ARCH}.node"
OUT_FALLBACK="$NATIVE_DIR/triviumdb.node"

echo "[4/4] Installing binary to $OUT_PRIMARY..."
cp -f "$SO_PATH" "$OUT_PRIMARY"
cp -f "$SO_PATH" "$OUT_FALLBACK"

echo "Verifying Node N-API addon load..."
node -e "const { TriviumDB } = require('$NATIVE_DIR/index.js'); console.log('Loaded TriviumDB successfully:', typeof TriviumDB);"

echo "Done! Restart Project Σ to use the native TriviumDB engine."
