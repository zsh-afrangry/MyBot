#!/usr/bin/env bash
# Start DSH and Fusion; QQ and SnowLuma are independently managed.
set -euo pipefail
verbose=0
case "${1:-}" in
    --verbose) verbose=1 ;;
    '') ;;
    *) echo '用法：./Start-DSH.sh [--verbose]' >&2; exit 2 ;;
esac
if [[ $(id -u) -eq 0 ]]; then
    echo '请以 afrangry 普通用户运行；系统服务由脚本内部 sudo 管理。' >&2
    exit 1
fi
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
FUSION_DIR=/home/afrangry/kurumi-fusion
# Authenticate before any service changes. No password is stored in this script.
sudo -v
echo "正在启动 DSH 与融合助手…"
sudo systemctl start dsh-web.service
systemctl --user start kurumi-fusion.service
echo "QQ 与 SnowLuma 仅检查状态，不执行启动。"
# Separate diagnostics from JSON so a warning never breaks the compact summary.
health_dir=$(mktemp -d)
trap 'rm -rf "$health_dir"' EXIT
ready=0
for attempt in {1..8}; do
    if [[ -t 1 ]]; then printf '\r\033[K等待融合链路就绪（%s/8）…' "$attempt"; fi
    if node --disable-warning=ExperimentalWarning "$FUSION_DIR/scripts/fusion/health.mjs" >"$health_dir/health.json" 2>"$health_dir/errors.log"; then
        ready=1
        break
    fi
    # Offline external services need operator attention, not an automatic start.
    if ! systemctl --user is-active --quiet snowluma.service || ! systemctl --user is-active --quiet snowluma-qq.service; then
        break
    fi
    sleep 2
done
if [[ -t 1 ]]; then printf '\r\033[K'; fi
summary_ok=0
node "$FUSION_DIR/scripts/fusion/stack-summary.mjs" "$health_dir/health.json" && summary_ok=1
if [[ $verbose -eq 1 ]]; then
    cat "$health_dir/health.json"
    cat "$health_dir/errors.log" >&2
elif [[ -s "$health_dir/errors.log" ]]; then
    echo '诊断有附加信息，可运行 ./Start-DSH.sh --verbose 查看。'
fi
# The login URL may contain authentication material; display only to the operator.
auth_url=$(journalctl -u dsh-web.service -n 200 --no-pager -o cat 2>/dev/null | sed -n 's/.*dsh web: //p' | tail -n 1) || auth_url=''
if systemctl is-active --quiet dsh-web.service && [[ "$auth_url" == http://127.0.0.1:3080/* ]]; then
    printf 'DSH 本地入口：%s\n' "$auth_url"
    service_exec=$(systemctl show dsh-web.service -p ExecStart --value 2>/dev/null) || service_exec=''
    trusted_host=$(sed -n 's/.*--trusted-host \([^ ;]*\).*/\1/p' <<<"$service_exec")
    if [[ "$trusted_host" =~ ^[A-Za-z0-9.-]+\.ts\.net$ ]]; then
        printf 'DSH Tailscale 远端入口：https://%s%s\n' "$trusted_host" "${auth_url#http://127.0.0.1:3080}"
    else
        echo 'DSH Tailscale 远端入口：未配置有效的 *.ts.net trusted-host'
    fi
else
    echo 'DSH 认证入口见：journalctl -u dsh-web.service -n 50'
fi

if [[ $ready -ne 1 || $summary_ok -ne 1 ]]; then
    echo "QQ 通道或融合链路未完全就绪；请检查已有 QQ 登录与 SnowLuma 状态。"
    exit 1
fi
