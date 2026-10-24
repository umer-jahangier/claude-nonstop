#!/bin/sh
# claude-nonstop installer for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.sh | sh
#
# Brings everything it needs: a private Node.js runtime (checksum-verified, used only by
# claude-nonstop), Claude Code itself if it's missing (Anthropic's official installer),
# and the latest claude-nonstop release. Then it sets everything up. No admin rights are
# needed, and nothing needs running again: claude-nonstop keeps itself up to date.

set -eu

REPO="umer-jahangier/claude-nonstop"
HOME_DIR="${CLAUDE_NONSTOP_HOME:-$HOME/.claude-nonstop}"
APP="$HOME_DIR/app"
RUNTIME="$HOME_DIR/runtime"
BIN_DIR="${CLAUDE_NONSTOP_BIN_DIR:-$HOME/.local/bin}"
NODE_LINE="${CLAUDE_NONSTOP_NODE_LINE:-22}"

say() { printf '%s\n' "$*"; }
fail() {
	printf 'claude-nonstop install: %s\n' "$*" >&2
	exit 1
}

fetch() { # url -> stdout
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO- "$1"
	else
		fail "curl or wget is needed."
	fi
}

download() { # url file
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$1" -o "$2"
	else
		wget -qO "$2" "$1"
	fi
}

sha256() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	else
		sha256sum "$1" | cut -d' ' -f1
	fi
}

command -v tar >/dev/null 2>&1 || fail "tar is needed."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir -p "$HOME_DIR"
chmod 700 "$HOME_DIR"

# --------------------------------------------------------------------------- Node.js
case "$(uname -s)" in
Darwin) platform=darwin ;;
Linux) platform=linux ;;
*) fail "this installer is for macOS and Linux. On Windows, use install.ps1." ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=x64 ;;
arm64 | aarch64) arch=arm64 ;;
*) arch="" ;;
esac

NODE=""
if [ -n "$arch" ]; then
	sums=$(fetch "https://nodejs.org/dist/latest-v$NODE_LINE.x/SHASUMS256.txt") || sums=""
	line=$(printf '%s\n' "$sums" | grep -E " node-v[0-9.]+-$platform-$arch\.tar\.gz$" | head -n 1 || true)
	if [ -n "$line" ]; then
		want_sha=${line%% *}
		file=${line##* }
		version=$(printf '%s' "$file" | sed -E 's/^node-(v[0-9.]+)-.*/\1/')
		current=""
		[ -x "$RUNTIME/node/bin/node" ] && current=$("$RUNTIME/node/bin/node" -v 2>/dev/null || true)
		if [ "$current" != "$version" ]; then
			say "Downloading Node.js $version for claude-nonstop..."
			download "https://nodejs.org/dist/latest-v$NODE_LINE.x/$file" "$tmp/$file"
			[ "$(sha256 "$tmp/$file")" = "$want_sha" ] || fail "the Node.js download didn't match its published checksum."
			mkdir -p "$tmp/node"
			tar -xzf "$tmp/$file" -C "$tmp/node" --strip-components 1
			mkdir -p "$RUNTIME"
			rm -rf "$RUNTIME/node.old"
			[ -d "$RUNTIME/node" ] && mv "$RUNTIME/node" "$RUNTIME/node.old"
			mv "$tmp/node" "$RUNTIME/node"
			rm -rf "$RUNTIME/node.old"
		fi
		"$RUNTIME/node/bin/node" -v >/dev/null 2>&1 && NODE="$RUNTIME/node/bin/node"
	fi
fi
# Systems the official builds don't cover (for example Alpine) use their own Node 18+.
if [ -z "$NODE" ] && command -v node >/dev/null 2>&1; then
	major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
	[ "$major" -ge 18 ] && NODE=$(command -v node)
fi
[ -n "$NODE" ] || fail "couldn't set up Node.js on this system. Install Node.js 18 or newer from https://nodejs.org, then run this again."

# --------------------------------------------------------------------------- Claude Code
has_claude() {
	command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ] || [ -x "$HOME/.claude/local/claude" ]
}
if ! has_claude && [ "${CLAUDE_NONSTOP_SKIP_CLAUDE:-}" != "1" ]; then
	say "Installing Claude Code with Anthropic's official installer..."
	if command -v bash >/dev/null 2>&1 && fetch https://claude.ai/install.sh | bash; then
		say "Claude Code is installed."
	else
		say "! Claude Code couldn't be installed automatically. Get it from https://code.claude.com/docs/en/setup, then run: claude-nonstop setup"
	fi
fi

# --------------------------------------------------------------------------- claude-nonstop
ref="${CLAUDE_NONSTOP_REF:-}"
if [ -z "$ref" ]; then
	ref=$(fetch "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name"[^"]*"\([^"]*\)".*/\1/p' | head -n 1 || true)
	[ -n "$ref" ] || ref=main
fi
say "Downloading claude-nonstop ($ref)..."
fetch "https://codeload.github.com/$REPO/tar.gz/$ref" | tar -xz -C "$tmp"
src=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d ! -name node | head -n 1)
[ -f "$src/bin/claude-nonstop.js" ] || fail "the download didn't contain claude-nonstop."

rm -rf "$APP.new"
mkdir -p "$APP.new"
cp -R "$src/bin" "$src/src" "$src/package.json" "$src/README.md" "$src/LICENSE" "$APP.new/"
rm -rf "$APP"
mv "$APP.new" "$APP"

# The command runs on claude-nonstop's own Node.js, whatever the system has.
mkdir -p "$BIN_DIR"
rm -f "$BIN_DIR/claude-nonstop"
cat >"$BIN_DIR/claude-nonstop" <<EOF
#!/bin/sh
exec "$NODE" "$APP/bin/claude-nonstop.js" "\$@"
EOF
chmod +x "$BIN_DIR/claude-nonstop"
say "Installed claude-nonstop $("$NODE" "$APP/bin/claude-nonstop.js" --version) to $APP"
say ""

# --------------------------------------------------------------------------- setup
# When this script arrives through a pipe, setup still asks its question on the terminal.
if [ -z "${CLAUDE_NONSTOP_SETUP_ARGS:-}" ] && [ -t 1 ] && (exec </dev/tty) 2>/dev/null; then
	"$NODE" "$APP/bin/claude-nonstop.js" setup --yes --bin-dir "$BIN_DIR" </dev/tty
else
	# shellcheck disable=SC2086
	"$NODE" "$APP/bin/claude-nonstop.js" setup --bin-dir "$BIN_DIR" ${CLAUDE_NONSTOP_SETUP_ARGS:---yes --no-open}
fi

case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*) say "" && say "Open a new terminal to use the claude-nonstop and claude commands." ;;
esac
