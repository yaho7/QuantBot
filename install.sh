#!/usr/bin/env bash
# Install or update QuantBot for the current user:
#
#   curl -fsSL https://raw.githubusercontent.com/yaho7/QuantBot/main/install.sh | bash
#
# Pass --non-interactive for automation or --no-service to install without starting a service.
set -euo pipefail

REPO="${QUANTBOT_REPO:-https://github.com/yaho7/QuantBot}"
REF="${QUANTBOT_REF:-main}"
non_interactive=false
no_service=false

usage() {
  cat <<'EOF'
用法  bash install.sh [--non-interactive] [--no-service]
  -y, --non-interactive  使用默认配置，跳过交互问答
  --no-service           只安装程序并保存配置，跳过服务启动
  -h, --help             显示帮助

QUANTBOT_PORT 可指定首次安装的端口。
QUANTBOT_REF 可指定安装分支、标签或提交。
非交互安装可通过 QUANTBOT_ADMIN_USERNAME 和 QUANTBOT_ADMIN_PASSWORD 设置管理员。
EOF
}

status() {
  local label="$1" color="$2"
  shift 2
  if [[ -t 1 && -z "${NO_COLOR+x}" && "${TERM:-}" != dumb ]]; then
    printf '\033[%sm[%s]\033[0m %s\n' "$color" "$label" "$*"
  else
    printf '[%s] %s\n' "$label" "$*"
  fi
}

die() {
  status 失败 '1;31' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive|-y) non_interactive=true ;;
    --no-service) no_service=true ;;
    --help|-h) usage; exit 0 ;;
    *) die "不支持的参数 $1。运行 bash install.sh --help 查看用法。" ;;
  esac
  shift
done

if [[ "$non_interactive" == false ]]; then
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then
    non_interactive=true
  fi
fi

printf '\n==================== QuantBot 安装 ====================\n\n'
status 进行 '1;36' "检查系统依赖。"


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
  status 进行 '1;36' "安装系统依赖  ${missing[*]}"
  install_packages "${missing[@]}" || die "系统依赖安装失败。请检查上方输出后重试。"
fi

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v uv >/dev/null; then
  status 进行 '1;36' "安装 uv。"
  curl -fsSL https://astral.sh/uv/install.sh | sh || die "uv 安装失败。请检查上方输出后重试。"
fi
command -v uv >/dev/null || die "当前终端找不到 uv。请重新打开终端后重试。"
status 完成 '1;32' "系统依赖已就绪。"

BIN="$(uv tool dir --bin)" || die "无法读取 uv 的命令目录。"
export PATH="$BIN:$PATH"
command_path="$BIN/quantbot"
setup_args=(setup)
if [[ "$no_service" == true ]]; then
  setup_args+=(--no-service)
fi

if [[ "$non_interactive" == false && -x "$command_path" ]]; then
  printf '\n检测到已安装的 QuantBot\n  1. 更新程序并应用现有配置\n  2. 重新配置当前版本\n  3. 退出\n' >&3
  while true; do
    printf '› 请选择 [1] ' >&3
    if ! IFS= read -r choice <&3; then
      choice=3
    fi
    case "${choice:-1}" in
      1) break ;;
      2) exec "$command_path" "${setup_args[@]}" <&3 >&3 ;;
      3) status 提示 '1;36' "已退出安装。"; exit 0 ;;
      *) status 注意 '1;33' "请输入 1、2 或 3。" >&3 ;;
    esac
  done
fi

# uv provisions Python 3.12 as needed.
status 进行 '1;36' "安装 QuantBot（${REF}）。"
uv tool install --quiet --force --reinstall --python 3.12 "quantbot @ git+${REPO}@${REF}" \
  || die "QuantBot 安装失败。请检查上方输出后重试。"
[[ -x "$command_path" ]] || die "安装后未找到命令 ${command_path}。"
uv tool update-shell >/dev/null 2>&1 || true
status 完成 '1;32' "程序已安装  $command_path"

setup_args+=(--if-needed)
if [[ "$non_interactive" == false && "$no_service" == false ]]; then
  exec "$command_path" "${setup_args[@]}" <&3 >&3
fi

setup_help="$("$command_path" setup --help)" || die "无法读取当前版本的配置命令。"
case "$setup_help" in
  *--non-interactive*)
    if [[ "$non_interactive" == true ]]; then
      exec "$command_path" "${setup_args[@]}" --non-interactive
    fi
    exec "$command_path" "${setup_args[@]}" <&3 >&3
    ;;
  *)
    # Older pinned releases have no unattended setup command.
    if [[ "$no_service" == true ]]; then
      status 提示 '1;36' "当前版本的交互配置命令为 quantbot setup。"
      exit 0
    fi
    exec "$command_path" service install ${QUANTBOT_PORT:+--port "$QUANTBOT_PORT"}
    ;;
esac
