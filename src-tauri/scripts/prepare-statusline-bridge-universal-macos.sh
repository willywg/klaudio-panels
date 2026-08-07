#!/usr/bin/env bash
# Builds klaudio-statusline-bridge for both macOS architectures and combines
# them with `lipo` into the single universal-binary sidecar Tauri's
# `bundle.externalBin` expects when packaging with `--target
# universal-apple-darwin` (mirrors this repo's release flow for the main
# app itself — see docs/release-flow.md). macOS-only: `lipo` doesn't exist
# on Linux/Windows, and cross-compiling either Darwin target without a real
# macOS + Xcode toolchain isn't supported here.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
    echo "error: this script only runs on macOS (needs lipo + the Xcode toolchain)" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_NAME="klaudio-statusline-bridge"

X86_TARGET="x86_64-apple-darwin"
ARM_TARGET="aarch64-apple-darwin"
UNIVERSAL_TARGET="universal-apple-darwin"

echo "==> preparing $X86_TARGET slice"
"$SCRIPT_DIR/prepare-statusline-bridge.sh" "$X86_TARGET"

echo "==> preparing $ARM_TARGET slice"
"$SCRIPT_DIR/prepare-statusline-bridge.sh" "$ARM_TARGET"

X86_BIN="$SRC_TAURI_DIR/binaries/$BIN_NAME-$X86_TARGET"
ARM_BIN="$SRC_TAURI_DIR/binaries/$BIN_NAME-$ARM_TARGET"
UNIVERSAL_BIN="$SRC_TAURI_DIR/binaries/$BIN_NAME-$UNIVERSAL_TARGET"

echo "==> combining slices with lipo"
rm -f "$UNIVERSAL_BIN"
lipo -create -output "$UNIVERSAL_BIN" "$X86_BIN" "$ARM_BIN"
chmod +x "$UNIVERSAL_BIN"

if [ ! -x "$UNIVERSAL_BIN" ]; then
    echo "error: universal binary missing or not executable after lipo: $UNIVERSAL_BIN" >&2
    exit 1
fi

echo "==> verifying both architectures are present"
lipo_info="$(lipo -info "$UNIVERSAL_BIN")"
echo "    $lipo_info"
case "$lipo_info" in
    *x86_64*arm64* | *arm64*x86_64*) ;;
    *)
        echo "error: expected both x86_64 and arm64 in the universal binary, got: $lipo_info" >&2
        exit 1
        ;;
esac

echo "==> verifying (native arch — invoking with empty stdin, no context file)"
if ! "$UNIVERSAL_BIN" </dev/null >/dev/null 2>&1; then
    echo "error: universal binary failed to run: $UNIVERSAL_BIN" >&2
    exit 1
fi

# Tauri's bundler does NOT read the universal sidecar from `binaries/` the
# way it does for a single-arch target. With `--target universal-apple-darwin`
# it builds each arch, lipos the *main* binary into
# `target/universal-apple-darwin/release/`, and then expects every
# `externalBin` sidecar to already sit beside it in that same directory,
# under its bare name with no target-triple suffix. Staging only
# `binaries/<name>-universal-apple-darwin` fails the bundle step with
# "Failed to copy binary from target/universal-apple-darwin/release/<name>:
# does not exist". `binaries/` still has to be populated — that's what
# `externalBin` validates at build-script time — so both copies are needed,
# not one instead of the other.
TARGET_RELEASE_DIR="$SRC_TAURI_DIR/target/$UNIVERSAL_TARGET/release"
echo "==> staging the sidecar where the bundler looks for it"
mkdir -p "$TARGET_RELEASE_DIR"
cp "$UNIVERSAL_BIN" "$TARGET_RELEASE_DIR/$BIN_NAME"
chmod +x "$TARGET_RELEASE_DIR/$BIN_NAME"
echo "    $TARGET_RELEASE_DIR/$BIN_NAME"

echo "==> ready: $UNIVERSAL_BIN"
