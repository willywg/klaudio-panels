#!/usr/bin/env bash
# Builds klaudio-statusline-bridge for one explicit target triple and stages
# it at the exact target-suffixed path Tauri's `bundle.externalBin` (see
# ../tauri.bundle.conf.json) expects a sidecar binary at before `cargo
# check`/`cargo build` runs for a packaged build.
#
# Not needed for plain contributor workflows (`cargo check`, `bun tauri
# dev`) — those resolve the bridge next to the dev binary in `target/debug/`
# instead (see `statusline_context::resolve_bridge_binary_path`). Only run
# this immediately before a release/packaged build. Never commit its output
# to git — see ../.gitignore.
set -euo pipefail

usage() {
    echo "usage: $(basename "$0") <target-triple>" >&2
    echo "example: $(basename "$0") x86_64-unknown-linux-gnu" >&2
    echo "example: $(basename "$0") aarch64-apple-darwin" >&2
    exit 1
}

[ $# -eq 1 ] || usage
TARGET="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_NAME="klaudio-statusline-bridge"

exe_suffix=""
case "$TARGET" in
    *windows*) exe_suffix=".exe" ;;
esac

DEST="$SRC_TAURI_DIR/binaries/$BIN_NAME-$TARGET$exe_suffix"
BUILT="$SRC_TAURI_DIR/target/$TARGET/release/$BIN_NAME$exe_suffix"

echo "==> ensuring rust target '$TARGET' is installed"
rustup target add "$TARGET" >/dev/null

echo "==> building $BIN_NAME for $TARGET (release)"
(cd "$SRC_TAURI_DIR" && cargo build --release --bin "$BIN_NAME" --target "$TARGET")

if [ ! -f "$BUILT" ]; then
    echo "error: expected build output missing: $BUILT" >&2
    exit 1
fi

mkdir -p "$SRC_TAURI_DIR/binaries"

echo "==> staging at $DEST"
# Remove any stale artifact first — a previous run for this same target (or
# a leftover from before a target-triple naming change) must never linger
# and be silently picked up instead of today's build.
rm -f "$DEST"
cp "$BUILT" "$DEST"
chmod +x "$DEST"

if [ ! -f "$DEST" ]; then
    echo "error: staged binary missing after copy: $DEST" >&2
    exit 1
fi
if [ ! -x "$DEST" ]; then
    echo "error: staged binary is not executable: $DEST" >&2
    exit 1
fi

host_target="$(rustc -vV | awk '/^host:/ { print $2 }')"
if [ "$TARGET" = "$host_target" ]; then
    # Only meaningful for a native (non-cross-compiled) target — running a
    # binary built for another OS/arch here would just fail to exec. With
    # no KLAUDIO_CONTEXT_FILE set and stdin already at EOF, the bridge's
    # documented fail-open path (see its own module doc comment) drains
    # stdin and exits 0 immediately, so this is a fast, safe smoke check.
    echo "==> verifying (native target — invoking with empty stdin, no context file)"
    if ! "$DEST" </dev/null >/dev/null 2>&1; then
        echo "error: staged binary failed to run: $DEST" >&2
        exit 1
    fi
else
    echo "==> skipping execution check (cross-compiled for $TARGET on host $host_target) — verified file presence and executable bit only"
fi

echo "==> ready: $DEST"
