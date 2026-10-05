#!/usr/bin/env bash
# Stop the same stack as Start-DSH.sh, without deleting state or disabling autostart.
set -uo pipefail
if [[ $(id -u) -eq 0 ]]; then
    echo '请以 afrangry 普通用户运行；系统服务由脚本内部 sudo 管理。' >&2
    exit 1
fi
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
sudo -v || exit 1
failed=0
# Stop consumers before transports. Also stop any accidentally revived old consumer.
for unit in kurumi-fusion qq-bridge openclaw-gateway snowluma-qq snowluma; do
    systemctl --user stop "$unit.service" || failed=1
done
sudo systemctl stop dsh-web.service || failed=1
for unit in kurumi-fusion qq-bridge openclaw-gateway snowluma-qq snowluma; do
    state=$(systemctl --user show "$unit.service" -p ActiveState --value) || { failed=1; continue; }
    printf '  %-28s %s\n' "$unit.service" "$state"
    [[ "$state" == inactive || "$state" == failed ]] || failed=1
done
state=$(systemctl show dsh-web.service -p ActiveState --value) || failed=1
printf '  %-28s %s\n' dsh-web.service "$state"
[[ "$state" == inactive || "$state" == failed ]] || failed=1
if [[ $failed -eq 0 ]]; then
    echo '整套服务已停止；源码、登录状态、聊天和提醒保留。再次启动请运行 Start-DSH.sh。'
fi
exit "$failed"
