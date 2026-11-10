#!/usr/bin/env bash
# Install or update QuantBot for the current user:
#
#   curl -fsSL https://raw.githubusercontent.com/yaho7/QuantBot/main/install.sh | bash
#
# Installs what it needs (git, uv and a Python for QuantBot), installs the
# `quantbot` command, asks the setup questions the first time, and runs
# QuantBot in the background (systemd on Linux, launchd on macOS).
# Running it again updates QuantBot. QUANTBOT_REF picks a tag or branch.
# QuantBot listens on a random free port on 127.0.0.1 unless QUANTBOT_PORT is set:
#
#   curl -fsSL .../install.sh | QUANTBOT_PORT=23456 bash
set -euo pipefail

REPO="${QUANTBOT_REPO:-https://github.com/yaho7/QuantBot}"
REF="${QUANTBOT_REF:-main}"
PORT="${QUANTBOT_PORT:-}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null; then sudo "$@"
  else die "需要管理员权限来安装 $*，但没有 sudo。请用 root 运行一次。"
  fi
}

# Install system packages with whatever package manager this machine has.
install_packages() {
  if command -v apt-get >/dev/null; then
    as_root apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif command -v dnf >/dev/null; then as_root dnf install -y -q "$@"
  elif command -v yum >/dev/null; then as_root yum install -y -q "$@"
  elif command -v apk >/dev/null; then as_root apk add --no-cache "$@"
  elif command -v pacman >/dev/null; then as_root pacman -Sy --noconfirm --needed "$@"
  elif command -v zypper >/dev/null; then as_root zypper --non-interactive install "$@"
  elif command -v brew >/dev/null; then brew install "$@"
  elif [ "$(uname)" = Darwin ]; then
    xcode-select --install 2>/dev/null || true
    die "请在弹出的窗口里安装命令行工具（含 git），装好后再运行一次。"
  else die "找不到包管理器，请先手动安装：$*"
  fi
}

missing=()
for tool in git curl; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if [ "$(uname)" = Linux ] && ! command -v update-ca-certificates >/dev/null \
   && [ ! -d /etc/ssl/certs ]; then
  missing+=(ca-certificates)
fi
if [ "${#missing[@]}" -gt 0 ]; then
  say "安装依赖：${missing[*]}…"
  install_packages "${missing[@]}"
fi

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v uv >/dev/null; then
  say "安装 uv…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
command -v uv >/dev/null || die "装好了 uv 但找不到它，请开一个新终端再运行一次。"

# uv downloads Python 3.12 for QuantBot if this machine does not have it.
say "安装 QuantBot（${REF}）…"
uv tool install --force --reinstall --python 3.12 "quantbot @ git+${REPO}@${REF}"
BIN="$(uv tool dir --bin)"
export PATH="$BIN:$PATH"
uv tool update-shell >/dev/null 2>&1 || true  # new terminals find `quantbot`

if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  # First time: the setup questions (bot, account, port, quiet hours, background).
  # Already set up: restart the background service on the new version.
  QUANTBOT_PORT="$PORT" quantbot setup --if-needed </dev/tty >/dev/tty || true
else
  say "没有终端，跳过设置问题。"
  quantbot service install ${PORT:+--port "$PORT"} || say "没能装成后台服务。"
  echo "  之后请运行：quantbot setup"
fi

say ""
say "✓ QuantBot 装好了。"
echo "  连接一个策略：cd 你的策略项目 && quantbot link"
echo "  新开一个终端，quantbot 命令就能直接用。"
