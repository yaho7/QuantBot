#!/usr/bin/env bash
# Install a published Linux binary for the current user.
set -euo pipefail

repo="${QUANTBOT_REPO:-https://github.com/yaho7/QuantBot}"
tag="${QUANTBOT_REF:-v3.1.1}"
destination="${QUANTBOT_INSTALL_DIR:-$HOME/.local/bin}"

case "${1:-}" in
  -h|--help)
    printf '%s\n' 'Usage: bash install.sh [--ref <release-tag>]' \
      'Set QUANTBOT_INSTALL_DIR to choose the destination directory.' \
      'After installing, run quantbot serve and open http://127.0.0.1:23456.'
    exit 0
    ;;
  --ref)
    [[ $# -eq 2 ]] || { printf '%s\n' 'Expected a release tag after --ref.' >&2; exit 2; }
    tag="$2"
    ;;
  '')
    ;;
  *)
    printf '%s\n' 'Use --help to see installation options.' >&2
    exit 2
    ;;
esac
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf '%s\n' 'Use a release tag such as v3.1.1.' >&2
  exit 2
fi
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) arch=amd64 ;;
  Linux:aarch64|Linux:arm64) arch=arm64 ;;
  *) printf '%s\n' 'Published binaries support Linux amd64 and arm64.' >&2; exit 1 ;;
esac
asset="quantbot-linux-$arch"
mkdir -p "$destination"
temp="$(mktemp -d "$destination/.quantbot-install.XXXXXX")"
trap 'rm -rf "$temp"' EXIT
base="${repo%/}/releases/download/$tag"
curl --proto '=https' --tlsv1.2 -fsSLo "$temp/$asset" "$base/$asset"
curl --proto '=https' --tlsv1.2 -fsSLo "$temp/$asset.sha256" "$base/$asset.sha256"
(cd "$temp" && sha256sum --check "$asset.sha256")
chmod 0755 "$temp/$asset"
test "$("$temp/$asset" version)" = "${tag#v}"
mv -f "$temp/$asset" "$destination/quantbot"
printf 'Installed QuantBot %s. Run %s serve.\n' "$tag" "$destination/quantbot"
