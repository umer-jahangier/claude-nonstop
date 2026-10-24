#!/bin/sh
# claude-nonstop installer for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.sh | sh
# Installs into ~/.claude-nonstop/app, puts `claude-nonstop` in ~/.local/bin, then runs
# `claude-nonstop setup`. Re-run it any time to update.

set -eu

REPO="umer-jahangier/claude-nonstop"
REF="${CLAUDE_NONSTOP_REF:-main}"
HOME_DIR="${CLAUDE_NONSTOP_HOME:-$HOME/.claude-nonstop}"
APP="$HOME_DIR/app"
BIN_DIR="${CLAUDE_NONSTOP_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() {
	printf 'claude-nonstop install: %s\n' "$*" >&2
	exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 18 or newer is needed. Get it from https://nodejs.org (or your package manager), then run this again."
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 18 ] || fail "Node.js 18 or newer is needed; this machine has $(node -v)."
command -v curl >/dev/null 2>&1 || fail "curl is needed."
command -v tar >/dev/null 2>&1 || fail "tar is needed."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading claude-nonstop ($REF)..."
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$tmp"
src=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -f "$src/bin/claude-nonstop.js" ] || fail "the download didn't contain claude-nonstop."

mkdir -p "$HOME_DIR"
chmod 700 "$HOME_DIR"
rm -rf "$APP.new"
mkdir -p "$APP.new"
cp -R "$src/bin" "$src/src" "$src/package.json" "$src/README.md" "$src/LICENSE" "$APP.new/"
rm -rf "$APP"
mv "$APP.new" "$APP"
chmod +x "$APP/bin/claude-nonstop.js"

mkdir -p "$BIN_DIR"
ln -sf "$APP/bin/claude-nonstop.js" "$BIN_DIR/claude-nonstop"
say "Installed claude-nonstop $(node "$APP/bin/claude-nonstop.js" --version) to $APP"
say ""

# When this script arrives through a pipe, setup still asks its question on the terminal.
if [ -z "${CLAUDE_NONSTOP_SETUP_ARGS:-}" ] && [ -t 1 ] && (exec </dev/tty) 2>/dev/null; then
	node "$APP/bin/claude-nonstop.js" setup --bin-dir "$BIN_DIR" </dev/tty
else
	# shellcheck disable=SC2086
	node "$APP/bin/claude-nonstop.js" setup --bin-dir "$BIN_DIR" ${CLAUDE_NONSTOP_SETUP_ARGS:---yes --no-open}
fi

case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*) say "" && say "Open a new terminal (or run: export PATH=\"$BIN_DIR:\$PATH\") to use the claude-nonstop command." ;;
esac
