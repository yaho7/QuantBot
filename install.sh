#!/usr/bin/env bash
# Install or update the QuantBot service CLI in the current user's uv tool directory.
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'HELP'
Usage: bash install.sh [--ref <tag-or-commit>]
Set QUANTBOT_REPO to override the source repository.
Set QUANTBOT_REF to pin a release or commit. The default is main.
After installation, run quantbot admin and quantbot serve.
HELP
  exit 0
fi

repo="${QUANTBOT_REPO:-https://github.com/yaho7/QuantBot}"
ref="${QUANTBOT_REF:-main}"
if [[ "${1:-}" == "--ref" && $# -eq 2 ]]; then
  ref="$2"
elif (( $# )); then
  printf '%s\n' 'Use --help to see installation options.' >&2
  exit 2
fi

if ! command -v uv >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -fsSL https://astral.sh/uv/install.sh | sh
  export PATH="${UV_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
fi

uv tool install --force --python 3.12 "git+${repo}@${ref}"
printf '%s\n' 'QuantBot CLI installed. See the README for configuration, service startup and migration.'
