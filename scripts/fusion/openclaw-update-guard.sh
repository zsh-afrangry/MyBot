# Interactive-shell guard against `openclaw update` (A4, see docs/10_融合助手运行维护.md).
#
# Fusion is pinned to OpenClaw 2026.9.7. The repo's node_modules/openclaw is a symlink to the
# global install (~/.npm-global/lib/node_modules/openclaw), so a global `openclaw update`
# replaces the repo dependency too and the running Gateway exits (incident A1, 2026-10-20).
#
# This file only defines a shell function; it changes nothing by itself. To enable it, the
# owner adds one line to their own ~/.bashrc or ~/.zshrc:
#   . /home/afrangry/kurumi-fusion/scripts/fusion/openclaw-update-guard.sh
#
# Read-only forms (`update status`, `--dry-run`, `--help`) pass through. A deliberate upgrade
# must be prefixed with KURUMI_ALLOW_OPENCLAW_UPDATE=1. It does not stop `npm i -g`, scripts
# that call the binary by absolute path, or `command openclaw update`.

openclaw() {
  if [ "${1:-}" = "update" ] && [ "${KURUMI_ALLOW_OPENCLAW_UPDATE:-}" != "1" ]; then
    case " $* " in
      *" status "*|*" --dry-run "*|*" --help "*|*" -h "*) ;;
      *)
        echo "已拦截 openclaw update：Fusion 固定在 OpenClaw 2026.9.7，升级会替换全局安装并让 Gateway 退出。" >&2
        echo "确需升级先读文档 10，再用 KURUMI_ALLOW_OPENCLAW_UPDATE=1 openclaw update ..." >&2
        return 1
        ;;
    esac
  fi
  command openclaw "$@"
}
