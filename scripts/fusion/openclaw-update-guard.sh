# Interactive-shell guard against `openclaw update` (A4, see docs/9_QQ融合助手架构与开发计划.md#固定依赖与升级恢复).
#
# Fusion uses config/openclaw-release.json as its approved version. The repo's node_modules/openclaw is a symlink to the
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
        echo "已拦截 openclaw update：Fusion 使用经过隔离验收的固定版本，升级会替换全局安装并让 Gateway 退出。" >&2
        echo "确需升级先读 /home/afrangry/.openclaw-fusion/整理记录.md 的恢复点与升级要求，再用 KURUMI_ALLOW_OPENCLAW_UPDATE=1 openclaw update ..." >&2
        return 1
        ;;
    esac
  fi
  command openclaw "$@"
}
