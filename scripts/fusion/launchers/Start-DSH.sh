#!/usr/bin/env bash
# DSH Web + fusion assistant. QQ transport is shared; never start legacy qq-bridge.
set -euo pipefail
if [[ $(id -u) -eq 0 ]]; then
    echo '请以 afrangry 普通用户运行；系统服务由脚本内部 sudo 管理。' >&2
    exit 1
fi
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
FUSION_DIR=/home/afrangry/kurumi-fusion
# Authenticate before any service changes. No password is stored in this script.
sudo -v
systemctl --user stop qq-bridge.service openclaw-gateway.service
sudo systemctl start dsh-web.service
systemctl --user start snowluma.service snowluma-qq.service kurumi-fusion.service
printf '\n已启动 DSH Web + Kurumi Fusion + SnowLuma QQ 传输。\n'
echo 'DSH 与融合助手独立运行；QQ 使用 .openclaw-fusion，模型不经由 DSH。'
# Fresh health probes wait for Gateway and QQ login rather than trusting active alone.
health_file=$(mktemp)
trap 'rm -f "$health_file"' EXIT
ready=0
for attempt in {1..8}; do
    if node "$FUSION_DIR/scripts/fusion/health.mjs" >"$health_file" 2>&1; then
        ready=1
        break
    fi
    echo "等待融合链路就绪（$attempt/8）…"
    sleep 2
done
cat "$health_file"
if [[ $ready -ne 1 ]]; then
    echo '服务已尝试启动，但健康检查未通过。请查上述问题及 journalctl --user -u kurumi-fusion -n 50。' >&2
    exit 1
fi
if ! systemctl is-active --quiet dsh-web.service; then
    echo 'DSH Web 未保持运行，请查 journalctl -u dsh-web -n 50。' >&2
    exit 1
fi
# The login URL may contain authentication material; display only to the operator.
auth_url=$(journalctl -u dsh-web.service -n 200 --no-pager -o cat 2>/dev/null | sed -n 's/.*dsh web: //p' | tail -n 1) || auth_url=''
if [[ "$auth_url" == http://127.0.0.1:3080/* ]]; then
    printf '\nDSH 本地入口：%s\n' "$auth_url"
else
    echo 'DSH 认证入口见：journalctl -u dsh-web.service -n 50'
fi
