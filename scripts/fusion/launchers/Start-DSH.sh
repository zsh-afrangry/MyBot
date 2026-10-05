#!/usr/bin/env bash
# DSH Web + fusion assistant. QQ transport is shared; never start legacy qq-bridge.
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
systemctl --user stop qq-bridge.service openclaw-gateway.service
sudo systemctl start dsh-web.service
systemctl --user start snowluma.service snowluma-qq.service kurumi-fusion.service
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
if [[ $ready -ne 1 || $summary_ok -ne 1 ]]; then exit 1; fi
# The login URL may contain authentication material; display only to the operator.
auth_url=$(journalctl -u dsh-web.service -n 200 --no-pager -o cat 2>/dev/null | sed -n 's/.*dsh web: //p' | tail -n 1) || auth_url=''
if [[ "$auth_url" == http://127.0.0.1:3080/* ]]; then
    printf 'DSH 本地入口：%s\n' "$auth_url"
else
    echo 'DSH 认证入口见：journalctl -u dsh-web.service -n 50'
fi
