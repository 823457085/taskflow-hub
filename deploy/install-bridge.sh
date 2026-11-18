#!/bin/sh
# TaskFlow 本机 Bridge 一键安装（macOS / Linux）
# 用法：sh install-bridge.sh https://服务器地址 [设备名称] [codex-cli|cursor]
# 安装到 ~/.taskflow：app/ 为客户端代码（可重复安装升级），state/ 为配对与配置（升级保留），bin/taskflow-bridge 为入口，
# workbench/ 为本机工作台（代码按版本存放，.env 与 data/ 升级保留）。设置 TASKFLOW_SKIP_WORKBENCH=1 只装 Bridge。
# macOS 上 Bridge 与工作台注册为登录自动运行，并每 6 小时检查服务器新版本：Bridge 空闲时自动替换重启，工作台新版本在下次重启时生效。
set -eu

HUB=${1:-}
[ -n "$HUB" ] || { echo "用法：sh install-bridge.sh https://服务器地址 [设备名称] [codex-cli|cursor]" >&2; exit 1; }
HUB=${HUB%/}
case "$HUB" in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "服务器地址必须以 https:// 开头" >&2; exit 1 ;;
esac
NAME=${2:-$(scutil --get ComputerName 2>/dev/null || hostname)}
TOOL=${3:-codex-cli}
ROOT=${TASKFLOW_HOME:-$HOME/.taskflow}

command -v node >/dev/null 2>&1 || { echo "未找到 Node.js，请先安装 Node.js 24 或更高版本" >&2; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "需要 Node.js 24+，当前为 $(node -v)" >&2; exit 1; }
NODE_BIN=$(command -v node)

mkdir -p "$ROOT/bin" "$ROOT/state"
chmod 700 "$ROOT" "$ROOT/state"
CA="$ROOT/taskflow-ca.pem"
TLS_OPT=""

if [ "${HUB#https://}" != "$HUB" ] && ! curl -fsS "$HUB/health" >/dev/null 2>&1; then
  # 服务器使用自签名证书：先取回证书，由用户核对指纹后再用它校验后续下载。
  curl -fsSk "$HUB/taskflow-ca.pem" -o "$CA.tmp"
  FP=$(openssl x509 -in "$CA.tmp" -noout -fingerprint -sha256 | cut -d= -f2)
  if [ -n "${TASKFLOW_CA_SHA256:-}" ]; then
    [ "$FP" = "$TASKFLOW_CA_SHA256" ] || { rm -f "$CA.tmp"; echo "证书指纹与 TASKFLOW_CA_SHA256 不一致，已停止" >&2; exit 1; }
  else
    echo "服务器证书 SHA-256 指纹：$FP"
    printf "与管理员公布的指纹一致吗？[y/N] "
    read -r ANSWER </dev/tty
    case "$ANSWER" in y|Y|yes|YES) ;; *) rm -f "$CA.tmp"; echo "已取消安装"; exit 1 ;; esac
  fi
  mv "$CA.tmp" "$CA"
  chmod 644 "$CA"
  TLS_OPT="--cacert $CA"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# shellcheck disable=SC2086
curl -fsS $TLS_OPT "$HUB/taskflow-bridge.tgz" -o "$TMP/bridge.tgz"
mkdir "$TMP/app"
tar xzf "$TMP/bridge.tgz" -C "$TMP/app"
[ -f "$TMP/app/local-bridge/rd.mjs" ] || { echo "下载的客户端包不完整" >&2; exit 1; }
rm -rf "$ROOT/app.old"
[ -d "$ROOT/app" ] && mv "$ROOT/app" "$ROOT/app.old"
mv "$TMP/app" "$ROOT/app"
if command -v npm >/dev/null 2>&1; then
  (cd "$ROOT/app/local-bridge" && npm install --omit=dev --no-audit --no-fund --silent >/dev/null 2>&1) \
    || echo "提示：MCP 依赖未安装，不影响 worker；需要 MCP 时在 $ROOT/app/local-bridge 运行 npm install"
fi

{
  echo '#!/bin/sh'
  echo "export RD_HUB_STATE_DIR=\"$ROOT/state\""
  [ -f "$CA" ] && echo "export NODE_EXTRA_CA_CERTS=\"$CA\""
  echo "exec \"$NODE_BIN\" \"$ROOT/app/local-bridge/rd.mjs\" \"\$@\""
} > "$ROOT/bin/taskflow-bridge"
chmod 755 "$ROOT/bin/taskflow-bridge"
BRIDGE="$ROOT/bin/taskflow-bridge"

if [ -f "$ROOT/state/session.json" ]; then
  echo "已存在设备配对，跳过配对（如需重新配对：$BRIDGE logout 后重新运行本脚本）"
else
  echo "开始配对：终端会显示配对码，请在网页「本机接入」中确认并勾选项目。"
  "$BRIDGE" pair --url "$HUB" --web-url "$HUB" --name "$NAME" --tool "$TOOL"
fi
[ -f "$ROOT/state/worker.json" ] || "$BRIDGE" worker-init --preset member >/dev/null

WORKBENCH_NOTE="已跳过工作台（TASKFLOW_SKIP_WORKBENCH=1）"
if [ -z "${TASKFLOW_SKIP_WORKBENCH:-}" ]; then
  if "$BRIDGE" workbench --action install; then
    WORKBENCH_NOTE="本机工作台：http://127.0.0.1:5288 ；网页工作台：在任务中心点「我的工作台」"
  else
    WORKBENCH_NOTE="工作台安装未完成，可稍后重试：$BRIDGE workbench --action install"
  fi
fi

if [ "$(uname)" = "Darwin" ]; then
  if "$BRIDGE" service --action install >/dev/null; then SERVICE_NOTE="Bridge 已设为登录自动运行"; else SERVICE_NOTE="Bridge 后台服务未能注册，请检查 $ROOT/state/worker.json 后运行：$BRIDGE service --action install"; fi
else
  SERVICE_NOTE="非 macOS：请用 systemd 或 pm2 常驻运行 $BRIDGE worker 与 $BRIDGE workbench --action run"
fi

case "$(basename "${SHELL:-sh}")" in
  zsh) RC="$HOME/.zshrc" ;;
  bash) RC="$HOME/.bash_profile" ;;
  *) RC="$HOME/.profile" ;;
esac
if grep -qsF "$ROOT/bin" "$RC"; then
  PATH_NOTE="$ROOT/bin 已在 $RC 的 PATH 中"
elif printf '\n# TaskFlow Bridge\nexport PATH="%s:$PATH"\n' "$ROOT/bin" >> "$RC"; then
  PATH_NOTE="已把 $ROOT/bin 加入 PATH（$RC），新开终端即可直接运行 taskflow-bridge"
else
  PATH_NOTE="未能写入 $RC，请用完整路径 $BRIDGE 运行"
fi

cat <<EOF

安装完成。
- ${PATH_NOTE}
- ${SERVICE_NOTE}；状态：$BRIDGE service --action status，日志：$ROOT/state/worker.log
- ${WORKBENCH_NOTE}
- 需要接收开发任务时，编辑 $ROOT/state/worker.json：把项目 ID 映射到本机代码仓库绝对路径，并把 allowDevelop 设为 true，然后运行 $BRIDGE service --action restart
- 自动更新默认开启；关闭请在 worker.json 加 "autoUpdate": false。立即检查：$BRIDGE update
EOF
