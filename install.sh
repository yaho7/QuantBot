#!/usr/bin/env bash
# Install or update QuantBot for the current user:
#
#   curl -fsSL https://raw.githubusercontent.com/yaho7/QuantBot/main/install.sh | bash
#
# Pass --non-interactive for automation or --no-service to install without starting a service.
set -euo pipefail

REPO="${QUANTBOT_REPO:-https://github.com/yaho7/QuantBot}"
REF="${QUANTBOT_REF:-}"
tag_pattern='^v(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$'
non_interactive=false
no_service=false
requested_language="${QUANTBOT_LANG:-}"
ui_language="${requested_language:-zh}"

msg() {
  if [[ "$ui_language" == en ]]; then
    printf '%s' "$2"
  else
    printf '%s' "$1"
  fi
}

usage() {
  if [[ "$ui_language" == en ]]; then
    cat <<'EOF'
Usage: bash install.sh [--language en|zh] [--non-interactive] [--no-service]
  -l, --language         Choose English (en) or Simplified Chinese (zh)
  -y, --non-interactive  Use defaults and skip prompts
  --no-service           Save configuration and skip service startup
  -h, --help             Show help

QUANTBOT_LANG selects the installer language.
QUANTBOT_PORT sets the initial listen port.
The latest stable Git tag is installed by default. QUANTBOT_REF pins a vX.Y.Z tag.
For non-interactive setup, set QUANTBOT_ADMIN_USERNAME and QUANTBOT_ADMIN_PASSWORD to configure the administrator.
EOF
    return
  fi
  cat <<'EOF'
用法  bash install.sh [--language en|zh] [--non-interactive] [--no-service]
  -l, --language         选择语言，en 为英语，zh 为简体中文
  -y, --non-interactive  使用默认配置，跳过交互问答
  --no-service           只安装程序并保存配置，跳过服务启动
  -h, --help             显示帮助

QUANTBOT_LANG 可指定安装语言。
QUANTBOT_PORT 可指定首次安装的端口。
默认安装最新的稳定 Git 标签。QUANTBOT_REF 可指定 vX.Y.Z 标签。
非交互安装可通过 QUANTBOT_ADMIN_USERNAME 和 QUANTBOT_ADMIN_PASSWORD 设置管理员。
EOF
}

status() {
  local label color="$2"
  case "$1" in
    step) label="$(msg 进行 Working)" ;;
    ok) label="$(msg 完成 Done)" ;;
    info) label="$(msg 提示 Info)" ;;
    warn) label="$(msg 注意 Warning)" ;;
    error) label="$(msg 失败 Error)" ;;
  esac
  shift 2
  if [[ -t 1 && -z "${NO_COLOR+x}" && "${TERM:-}" != dumb ]]; then
    printf '\033[%sm[%s]\033[0m %s\n' "$color" "$label" "$*"
  else
    printf '[%s] %s\n' "$label" "$*"
  fi
}

die() {
  status error '1;31' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --language|-l)
      [[ $# -ge 2 ]] || die "Use --language en or --language zh. / 请指定 en 或 zh。"
      requested_language="$2"
      ui_language="$2"
      shift
      ;;
    --non-interactive|-y) non_interactive=true ;;
    --no-service) no_service=true ;;
    --help|-h) usage; exit 0 ;;
    *) die "$(msg "不支持的参数 $1。运行 bash install.sh --help 查看用法。" "Unknown option $1. Run bash install.sh --help.")" ;;
  esac
  shift
done

if [[ "$non_interactive" == false ]]; then
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then
    non_interactive=true
  fi
fi

case "$ui_language" in
  en|zh) ;;
  *) die "Use --language en or --language zh. / 请指定 en 或 zh。" ;;
esac

if [[ "$non_interactive" == false && -z "$requested_language" ]]; then
  printf '\nQuantBot · Select language / 请选择语言\n  1. 简体中文\n  2. English\n' >&3
  while true; do
    printf '› Language / 语言 [1] ' >&3
    if ! IFS= read -r choice <&3; then
      exit 1
    fi
    case "${choice:-1}" in
      1|zh) requested_language=zh; break ;;
      2|en) requested_language=en; break ;;
      *) printf '%s\n' 'Choose 1 or 2. / 请输入 1 或 2。' >&3 ;;
    esac
  done
  ui_language="$requested_language"
fi
if [[ -n "$requested_language" ]]; then
  export QUANTBOT_LANG="$requested_language"
fi

printf '\n==================== %s ====================\n\n' "$(msg 'QuantBot 安装' 'QuantBot installation')"
status step '1;36' "$(msg '检查系统依赖。' 'Checking system dependencies.')"


as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null; then sudo "$@"
  else die "$(msg "需要管理员权限来安装 $*，但没有 sudo。请用 root 运行一次。" "Installing $* requires administrator privileges. Run the installer as root or install sudo.")"
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
    die "$(msg "请在弹出的窗口里安装命令行工具（含 git），装好后再运行一次。" "Install the Xcode Command Line Tools in the dialog, then rerun this installer.")"
  else die "$(msg "找不到包管理器，请先手动安装：$*" "No package manager found. Install these dependencies manually: $*")"
  fi
}

missing=()
for tool in git curl; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if [ "$(uname)" = Linux ] && ! command -v update-ca-certificates >/dev/null \
   && [ ! -d /etc/ssl/certs ]; then
  missing+=(ca-certificates)
fi
if [ "${#missing[@]}" -gt 0 ]; then
  status step '1;36' "$(msg "安装系统依赖  ${missing[*]}" "Installing system dependencies  ${missing[*]}")"
  install_packages "${missing[@]}" || die "$(msg "系统依赖安装失败。请检查上方输出后重试。" "Could not install system dependencies. Review the output above and retry.")"
fi

terminal_path="$PATH"
export PATH="$PATH:$HOME/.local/bin:$HOME/.cargo/bin"
if ! command -v uv >/dev/null; then
  status step '1;36' "$(msg "安装 uv。" "Installing uv.")"
  curl -fsSL https://astral.sh/uv/install.sh | sh || die "$(msg "uv 安装失败。请检查上方输出后重试。" "Could not install uv. Review the output above and retry.")"
fi
uv_path="$(command -v uv)" || die "$(msg "当前终端找不到 uv。请重新打开终端后重试。" "uv was not found. Open a new terminal and retry.")"
status ok '1;32' "$(msg "系统依赖已就绪。" "System dependencies are ready.")"

BIN="$("$uv_path" tool dir --bin)" || die "$(msg "无法读取 uv 的命令目录。" "Could not locate the uv executable directory.")"
export PATH="$BIN:$PATH"
command_path="$BIN/quantbot"

activate_commands() {
  if [[ ":$terminal_path:" == *":$BIN:"* ]]; then
    return
  fi
  # uv checks its caller's PATH before updating shell profiles.
  PATH="$terminal_path" "$uv_path" tool update-shell >/dev/null 2>&1 || true
  status info '1;36' "$(msg '在当前 Bash / Zsh 终端运行以下命令以启用命令入口。' 'Run this in your current Bash or Zsh session to make the commands available.')"
  printf '  export PATH=%q:"%s"\n' "$BIN" "\$PATH"
}

finish_setup() {
  local code=0
  if [[ "$non_interactive" == false ]]; then
    "$command_path" "$@" <&3 >&3 || code=$?
  else
    "$command_path" "$@" || code=$?
  fi
  activate_commands
  exit "$code"
}

newest_tag() {
  LC_ALL=C awk -v pattern="$tag_pattern" '$0 ~ pattern {
    version = $0
    sub(/^v/, "", version)
    print version, $0
  }' | LC_ALL=C sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 | awk '{print $2}'
}

setup_args=(setup)
if [[ "$no_service" == true ]]; then
  setup_args+=(--no-service)
fi

if [[ "$non_interactive" == false && -x "$command_path" ]]; then
  printf '\n%s\n' "$(msg '检测到已安装的 QuantBot
  1. 更新程序并应用现有配置
  2. 重新配置当前版本
  3. 退出' 'QuantBot is already installed
  1. Update and apply the current settings
  2. Reconfigure this version
  3. Exit')" >&3
  while true; do
    printf '› %s [1] ' "$(msg 请选择 Select)" >&3
    if ! IFS= read -r choice <&3; then
      choice=3
    fi
    case "${choice:-1}" in
      1) break ;;
      2) finish_setup "${setup_args[@]}" ;;
      3) status info '1;36' "$(msg "已退出安装。" "Installer exited.")"; exit 0 ;;
      *) status warn '1;33' "$(msg "请输入 1、2 或 3。" "Enter 1, 2, or 3.")" >&3 ;;
    esac
  done
fi

if [[ -z "$REF" ]]; then
  status step '1;36' "$(msg "检查 Git 版本标签。" "Checking Git version tags.")"
  remote_tags="$(git ls-remote --tags --refs -- "$REPO")" ||
    die "$(msg "无法读取仓库的版本标签。" "Could not read version tags from the repository.")"
  REF="$(printf '%s\n' "$remote_tags" | awk '{ sub(/^refs\/tags\//, "", $2); print $2 }' | newest_tag)"
  [[ -n "$REF" ]] || die "$(msg "仓库还没有可安装的版本标签。" "The repository has no installable version tags yet.")"
fi
REF="${REF#refs/tags/}"
[[ "$REF" =~ $tag_pattern ]] ||
  die "$(msg "QUANTBOT_REF 必须是 vX.Y.Z 标签。" "QUANTBOT_REF must be a vX.Y.Z tag.")"

# uv provisions Python 3.12 as needed.
status step '1;36' "$(msg "安装 QuantBot（${REF}）。" "Installing QuantBot (${REF}).")"
"$uv_path" tool install --quiet --force --reinstall --python 3.12 "quantbot @ git+${REPO}@refs/tags/${REF}" \
  || die "$(msg "QuantBot 安装失败。请检查上方输出后重试。" "Could not install QuantBot. Review the output above and retry.")"
[[ -x "$command_path" ]] || die "$(msg "安装后未找到命令 ${command_path}。" "The executable was not found after installation: ${command_path}.")"
status ok '1;32' "$(msg "程序已安装  $command_path" "Executable installed  $command_path")"

setup_args+=(--if-needed)
if [[ "$non_interactive" == true ]]; then
  setup_args+=(--non-interactive)
fi
finish_setup "${setup_args[@]}"
