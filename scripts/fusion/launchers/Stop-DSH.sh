#!/usr/bin/env bash
# Stop the same stack as Start-DSH.sh, without deleting state or disabling autostart.
set -uo pipefail
verbose=0
case "${1:-}" in
    --verbose) verbose=1 ;;
    '') ;;
    *) echo '用法：./Stop-DSH.sh [--verbose]' >&2; exit 2 ;;
esac
if [[ $(id -u) -eq 0 ]]; then
    echo '请以 afrangry 普通用户运行；系统服务由脚本内部 sudo 管理。' >&2
    exit 1
fi
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
sudo -v || exit 1
failed=0
warnings=0
echo '正在停止 DSH 与融合助手…'
show_state() {
    local unit="$1" state="$2"
    case "$state" in
        inactive) printf '✓ %-24s 已停止\n' "$unit" ;;
        failed) printf '⚠ %-24s 已停止，退出状态异常\n' "$unit"; warnings=1 ;;
        *) printf '✗ %-24s 未停止（%s）\n' "$unit" "$state"; failed=1 ;;
    esac
}
# Stop consumers before transports. Also stop any accidentally revived old consumer.
for unit in kurumi-fusion qq-bridge openclaw-gateway snowluma-qq snowluma; do
    systemctl --user stop "$unit.service" || failed=1
done
sudo systemctl stop dsh-web.service || failed=1
for unit in kurumi-fusion qq-bridge openclaw-gateway snowluma-qq snowluma; do
    state=$(systemctl --user show "$unit.service" -p ActiveState --value) || { failed=1; continue; }
    if [[ "$unit" != qq-bridge && "$unit" != openclaw-gateway ]] || [[ "$state" != inactive || $verbose -eq 1 ]]; then
        show_state "$unit" "$state"
    fi
    if [[ $verbose -eq 1 ]]; then systemctl --user show "$unit.service" -p ActiveState -p Result; fi
done
state=$(systemctl show dsh-web.service -p ActiveState --value) || failed=1
show_state 'DSH Web' "$state"
if [[ $verbose -eq 1 ]]; then systemctl show dsh-web.service -p ActiveState -p Result; fi
if [[ $failed -eq 0 ]]; then
    echo '整套服务已停止，配置与数据保留。'
    if [[ $warnings -eq 1 ]]; then echo '退出异常日志：journalctl --user -u snowluma -u snowluma-qq -n 50'; fi
fi
exit "$failed"
