#!/usr/bin/env bash
# restore-legacy.sh — 把封存的旧系统从归档复制还原到原路径，供明确回退使用。
#
# 设计原则（按主人 2026-10-05 的决定）：
#   * 归档保留 + 原路径复制恢复 + 显式切换；**不**重写旧系统内部路径。
#   * 默认只检查，不移动、不复制、不启动任何东西。
#   * 还原是"复制"而非"移动"：归档原件永远保留。
#   * 目标目录已存在就停止：**不覆盖、不合并**。
#   * 本脚本**不启动**任何服务。启动是独立的显式步骤，见脚本末尾打印的清单。
#   * 不把"自动启动验收"绑进来：旧提醒与旧外发规则可能随启动恢复，必须先人工核对。
#
# 用法：
#   ./restore-legacy.sh                 # 只检查（默认）
#   ./restore-legacy.sh --check         # 同上
#   ./restore-legacy.sh --restore --system A       # 预演：显示将要做什么，仍需 --confirm
#   ./restore-legacy.sh --restore --system A --confirm   # 真正执行复制还原
set -uo pipefail

ARCHIVE=/home/afrangry/kurumi-archive
BACKUPS=/home/afrangry/kurumi-backups
LEGACY_SRC="$ARCHIVE/legacy-openclaw"
BRIDGE_SRC="$ARCHIVE/qq-bridge"
LEGACY_DST=/home/afrangry/.openclaw
BRIDGE_DST=/home/afrangry/桌面/qq-bridge

# 融合侧的 QQ 消费者：还原前必须停，否则会出现两个消费者抢同一个 QQ 连接。
FUSION_CONSUMERS=(kurumi-fusion snowluma-qq snowluma)
# 旧系统的单元。若其 ExecStart 仍指向原路径，还原后无需修改单元文件。
LEGACY_UNITS=(openclaw-gateway qq-bridge)

MODE=check
CONFIRM=0
SYSTEM=both
while [ "$#" -gt 0 ]; do
    case "$1" in
        --check) MODE=check ;;
        --restore) MODE=restore ;;
        --confirm) CONFIRM=1 ;;
        --system) shift; SYSTEM=${1:-}; case "$SYSTEM" in A|B) ;; *) echo "--system 必须是 A 或 B" >&2; exit 2;; esac ;;
        -h|--help) echo "用法：$0 [--check] | --restore --system A|B [--confirm]"; exit 0 ;;
        *) echo "未知参数：$1" >&2; exit 2 ;;
    esac
    shift
done
if [ "$MODE" = restore ] && [ "$SYSTEM" = both ]; then
    echo "还原必须明确选择 --system A 或 --system B，不能同时还原并启动两个旧助手。" >&2
    exit 2
fi
PAIRS=()
[ "$SYSTEM" = B ] || PAIRS+=("$LEGACY_SRC:$LEGACY_DST:旧OpenClaw")
[ "$SYSTEM" = A ] || PAIRS+=("$BRIDGE_SRC:$BRIDGE_DST:旧bridge")

problems=0
warnings=0
ok()   { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; problems=$((problems+1)); }
warn() { printf '  ⚠ %s\n' "$1"; warnings=$((warnings+1)); }
info() { printf '    %s\n' "$1"; }

have() { [ -e "$1" ] || [ -L "$1" ]; }   # -L matters: [ -e ] is false for a DANGLING symlink,
                                          # which would let a broken link sit at the target and
                                          # pass the "target is empty" check.

# 内容清单（路径 + 普通文件内容哈希 + 符号链接目标）。用于证明"复制逐文件一致"，
# 而不是只比条目数——条目数相同不代表内容相同。
manifest_of() {
    python3 - "$1" <<'PYMANIFEST'
import os,sys,json,hashlib,stat
root=sys.argv[1]
for base,dirs,files in os.walk(root,followlinks=False):
    dirs.sort(); files.sort()
    for name in sorted(dirs+files):
        p=os.path.join(base,name);s=os.lstat(p);rel=os.path.relpath(p,root)
        if stat.S_ISLNK(s.st_mode): value=['link',os.readlink(p)]
        elif stat.S_ISREG(s.st_mode):
            h=hashlib.sha256()
            with open(p,'rb') as f:
                for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
            value=['file',h.hexdigest()]
        elif stat.S_ISDIR(s.st_mode): value=['dir']
        else: raise RuntimeError('Unsupported file type: '+rel)
        print(json.dumps([rel,stat.S_IMODE(s.st_mode),value],ensure_ascii=True))
PYMANIFEST
}

# 逐服务检查屏蔽状态：旧写法用一条正则匹配任意一行，只要有一个被 mask 就报"都已屏蔽"。
mask_state() {
    local unit="$1" state
    state=$(systemctl --user is-enabled "$unit.service" 2>/dev/null)
    [ "$state" = masked ] && echo masked || echo "$state"
}

# ---------------------------------------------------------------- 检查

check_archive() {
    echo "【1】归档原件"
    for pair in "${PAIRS[@]}"; do
        src=${pair%%:*}; label=${pair##*:}
        if have "$src"; then
            ok "$label 在归档：$(du -sh "$src" 2>/dev/null | cut -f1)"
        else
            bad "$label 归档缺失：$src"
        fi
    done
    if have "$LEGACY_SRC/.git"; then
        info "旧 OpenClaw git HEAD $(git -C "$LEGACY_SRC" rev-parse --short HEAD 2>/dev/null)，$(git -C "$LEGACY_SRC" ls-files 2>/dev/null | wc -l) 个跟踪文件"
    fi
}

check_backups() {
    echo "【2】备份恢复点"
    if have "$BACKUPS"; then
        ok "备份目录存在（$(du -sh "$BACKUPS" 2>/dev/null | cut -f1)）"
        # 按修改时间取最近几个。旧写法按名称排序，会输出 legacy-baselines-… 这种非检查点目录。
        info "最近修改的三个（按 mtime，非名称）："
        ls -dt "$BACKUPS"/*/ 2>/dev/null | head -3 | while read -r d; do
            printf '       %s  (%s)\n' "$(basename "$d")" "$(du -sh "$d" 2>/dev/null | cut -f1)"
        done
        # 真正的"回退点"要看 EXPECTED.json 里记录的 quiesced 真值，而不是目录名。
        local q
        q=$(python3 - "$BACKUPS" <<'PY' 2>/dev/null
import glob, json, os, sys
best = None
for p in glob.glob(os.path.join(sys.argv[1], '*', 'EXPECTED.json')):
    try:
        d = json.load(open(p))
    except Exception:
        continue
    if d.get('quiesced') is True and not d.get('failures') and not os.path.exists(os.path.join(os.path.dirname(p),'INCOMPLETE.json')):
        t = os.path.getmtime(p)
        if best is None or t > best[0]:
            best = (t, os.path.basename(os.path.dirname(p)))
print(best[1] if best else '')
PY
)
        if [ -n "$q" ]; then
            ok "最新且 quiesced=true 的回退点：$q"
        else
            warn "未找到 quiesced=true 的备份（跨库一致性未保证，提醒对账请谨慎）"
        fi
    else
        bad "备份目录不存在：$BACKUPS"
    fi
    if have "$BACKUPS/legacy-archive-state-2026-10-05"; then
        ok "旧系统全量归档现状快照存在（含 node_modules、忽略文件与符号链接）"
    else
        warn "未见旧系统全量归档现状快照"
    fi
}

check_targets() {
    echo "【3】目标原路径（必须为空，否则不覆盖不合并）"
    for pair in "${PAIRS[@]}"; do
        src=${pair%%:*}; rest=${pair#*:}; dst=${rest%%:*}
        if have "$dst"; then
            bad "目标已存在，还原会中止：$dst"
            info "请先确认它是否是要保留的现有数据；本脚本不会覆盖或合并。"
        else
            ok "目标为空：$dst"
        fi
        : "$src"
    done
    local avail
    avail=$(df -Pk /home | awk 'NR==2{print $4}')
    if [ "$avail" -gt 3000000 ]; then
        ok "磁盘空间充足（可用 $(( avail / 1048576 )) GiB，还原约需 1.3 GiB）"
    else
        warn "磁盘可用空间偏低：$(( avail / 1048576 )) GiB"
    fi
}

check_services() {
    echo "【4】服务状态"
    for u in "${FUSION_CONSUMERS[@]}"; do
        local st
        st=$(systemctl --user is-active "$u.service" 2>/dev/null)
        if [ "$st" = active ]; then
            info "融合消费者 $u.service = active（还原执行时会先停止它）"
        else
            info "融合消费者 $u.service = $st"
        fi
    done
    for u in "${LEGACY_UNITS[@]}"; do
        local en ac exec_line
        en=$(systemctl --user is-enabled "$u.service" 2>/dev/null)
        ac=$(systemctl --user is-active "$u.service" 2>/dev/null)
        exec_line=$(systemctl --user show "$u.service" -p ExecStart --value 2>/dev/null)
        printf '    旧单元 %-18s enabled=%-9s active=%-9s\n' "$u" "$en" "$ac"
        case "$u" in
            openclaw-gateway)
                # 该单元的 ExecStart 用的是**全局安装**的 openclaw（/home/afrangry/.npm-global/...），
                # 并不引用 .openclaw。真正引用原路径的是 EnvironmentFile。
                local unit_refs
                unit_refs=$(systemctl --user cat "$u.service" 2>/dev/null | grep -n "$LEGACY_DST" || true)
                if [ -n "$unit_refs" ]; then
                    ok "  $u 引用原路径的行（还原后自动生效，无需改单元）："
                    printf '       %s\n' "$unit_refs"
                else
                    warn "  $u 完全没有引用 $LEGACY_DST，请人工确认路径来源"
                fi
                # 关键：EnvironmentFile 带 '-' 前缀时，文件缺失会被忽略；
                # 且 ExecStart 指向全局安装，因此"路径失效"挡不住手动启动。
                if systemctl --user cat "$u.service" 2>/dev/null | grep -qE '^EnvironmentFile=-'; then
                    warn "  $u 的 EnvironmentFile 带 '-' 前缀：环境文件缺失**不会**让它启动失败"
                    info "  且 ExecStart 指向全局安装的 openclaw（仍存在），所以它能被手动拉起"
                fi
                ;;
            qq-bridge)
                if systemctl --user cat "$u.service" 2>/dev/null | grep -q 'WorkingDirectory'; then
                    info "  $u 有 WorkingDirectory，还原后按原路径生效"
                else
                    warn "  $u 的 ExecStart 用相对路径且未见 WorkingDirectory，需人工核对"
                fi
                ;;
        esac
    done
    # 逐服务检查屏蔽状态：旧写法用一条正则匹配任意一行，只要有一个被 mask 就报"都已屏蔽"。
    local all_masked=1
    for u in "${LEGACY_UNITS[@]}"; do
        local ms
        ms=$(mask_state "$u")
        printf '       %-20s is-enabled=%s\n' "$u" "$ms"
        [ "$ms" = masked ] || all_masked=0
    done
    if [ "$all_masked" -eq 1 ]; then
        ok "两个旧单元都已 mask，误启动风险已封死"
    else
        warn "旧单元未全部 mask：disabled 只表示不随开机启动，仍可被手动 start"
        info "如需封死：systemctl --user mask ${LEGACY_UNITS[*]/%/.service}"
    fi
}

check_links_and_deps() {
    echo "【5】符号链接与依赖"
    if have "$LEGACY_SRC"; then
        local total dangling
        total=$(find "$LEGACY_SRC" -type l 2>/dev/null | wc -l)
        dangling=$(find "$LEGACY_SRC" -type l ! -exec test -e {} \; -print 2>/dev/null | wc -l)
        info "归档中符号链接：$total 个，其中当前失效 $dangling 个"
        if [ "$dangling" -gt 0 ]; then
            info "失效原因：它们写死指向原路径，而原路径当前不存在 ——"
            info "4 个技能链接可恢复；历史 personal-search 链接仍可能失效，须核对。"
        fi
    fi
    local pkg
    for pkg in "$LEGACY_SRC"/chatbot/plugins/personal-confirmation/package.json \
               "$LEGACY_SRC"/chatbot/plugins/personal-weather/package.json; do
        if have "$pkg"; then
            local dev
            dev=$(grep -oE '"openclaw": "[^"]+"' "$pkg" | head -2 | tr '\n' ' ')
            info "$(basename "$(dirname "$pkg")"): $dev"
        fi
    done
    warn "旧系统依赖**未做过重建验证**；新系统的锁文件重装不能替代它。"
    info "新系统依赖是否自持可另跑：node scripts/fusion/verify-dependencies.mjs"
    echo
    echo "【5b】本工具「通过」的含义（避免过度理解）"
    info "本工具的检查只覆盖：归档存在性、目标路径为空、磁盘空间、服务状态、链接与依赖、启动前风险。"
    info "它**不**验证复制后的内容一致性 —— 那由还原步骤里的逐文件哈希清单负责（见还原输出）。"
    info "它**不**验证旧系统能启动、能收发消息 —— 那是独立的人工启动验收（docs/15）。"
}

# 启动前的风险审计：这是本脚本最重要的输出，因为旧提醒与旧外发规则会随启动恢复。
audit_legacy_state() {
    echo "【6】启动前风险审计（旧调度与旧外发规则会随启动恢复）"
    if ! command -v python3 >/dev/null 2>&1; then
        warn "无 python3，跳过调度与提醒审计（请人工核对）"
        return
    fi
    python3 - "$LEGACY_SRC" "$BRIDGE_SRC" <<'PY'
import json, os, sqlite3, sys
legacy, bridge = sys.argv[1], sys.argv[2]
risks = 0

def note(level, msg):
    global risks
    mark = {'RISK': '⚠', 'OK': '✓', 'INFO': ' '}[level]
    print(f'  {mark} {msg}')
    if level == 'RISK':
        risks += 1

# --- 旧 Cron：会在启动后按计划自行执行并可能外发 ---
cron_db = os.path.join(legacy, 'state', 'openclaw.sqlite')
if os.path.exists(cron_db):
    try:
        db = sqlite3.connect(f'file:{cron_db}?mode=ro', uri=True)
        rows = list(db.execute('select name, enabled, job_json from cron_jobs'))
        enabled = [(n, j) for n, e, j in rows if str(e) in ('1', 'true', 'True')]
        if enabled:
            note('RISK', f'旧 Cron 有 {len(enabled)} 个 enabled 任务，启动后会自行执行：')
            for n, j in enabled:
                try:
                    job = json.loads(j)
                except Exception:
                    job = {}
                sched = json.dumps(job.get('schedule') or {}, ensure_ascii=False)
                deliv = job.get('delivery') or job.get('payload', {}).get('delivery') or {}
                mode = deliv.get('mode')
                chan = deliv.get('channel')
                if mode and mode != 'none':
                    print(f'      · {n}  schedule={sched[:52]}  delivery={mode}/{chan}  ← 会实际外发')
                else:
                    print(f'      · {n}  schedule={sched[:52]}  delivery={mode or "none"}')
            note('INFO', '启动前建议逐个确认：不再需要的应先在旧系统内禁用，而不是靠启动后补救')
        else:
            note('OK', '旧 Cron 无 enabled 任务')
        db.close()
    except Exception as exc:
        note('RISK', f'旧 Cron 读取失败，需人工核对：{exc}')

# --- 旧提醒：未终态的可能在启动后投递 ---
rem_db = os.path.join(legacy, 'state', 'personal-reminders', 'reminders.sqlite')
if os.path.exists(rem_db):
    try:
        db = sqlite3.connect(f'file:{rem_db}?mode=ro', uri=True)
        rows = list(db.execute('select status, count(*) from reminders group by status'))
        terminal = {'delivered', 'cancelled', 'failed', 'expired'}
        pending = sum(c for s, c in rows if (s or '').lower() not in terminal)
        summary = ', '.join(f'{s}={c}' for s, c in rows)
        if pending:
            note('RISK', f'旧提醒库有 {pending} 条非终态提醒，启动后可能投递：{summary}')
        else:
            note('OK', f'旧提醒全部处于终态（{summary}）')
        db.close()
    except Exception as exc:
        note('RISK', f'旧提醒库读取失败，需人工核对：{exc}')

# --- 旧外发白名单：可能包含群，而新系统只向本人外发 ---
cfg_path = os.path.join(bridge, 'config.json')
if os.path.exists(cfg_path):
    try:
        cfg = json.load(open(cfg_path))
        allow = cfg.get('allow', {}) or {}
        groups = allow.get('groups', []) or []
        privates = allow.get('private', []) or []
        mask = lambda s: (str(s)[:2] + '*' * max(0, len(str(s)) - 4) + str(s)[-2:]) if len(str(s)) > 4 else str(s)
        note('INFO', f'旧外发白名单：私聊 {len(privates)} 个（{[mask(x) for x in privates]}），群 {len(groups)} 个')
        if groups:
            note('RISK', f'旧系统允许向 {len(groups)} 个群外发；新系统是仅本人私聊。'
                         '还原前请确认这些群是否仍应可达')
    except Exception as exc:
        note('RISK', f'旧 bridge config.json 读取失败：{exc}')

# --- 旧 bridge 运行模式：未暂停意味着它会主动参与会话 ---
soc = os.path.join(bridge, 'state', 'social-v2.json')
if os.path.exists(soc):
    try:
        d = json.load(open(soc))
        paused = d.get('paused')
        if paused:
            note('OK', '旧 bridge social-v2 处于 paused')
        else:
            note('RISK', '旧 bridge social-v2 **未暂停**，启动后会主动参与会话')
    except Exception as exc:
        note('RISK', f'旧 bridge social-v2.json 读取失败：{exc}')

print()
if risks:
    print(f'  合计 {risks} 项需要在启动前人工处理。')
else:
    print('  未发现需要启动前处理的风险项。')
PY
}

# ---------------------------------------------------------------- 还原

do_restore() {
    echo
    echo "【还原】复制归档 → 原路径（归档原件保留）"
    if [ "$CONFIRM" -ne 1 ]; then
        echo "  这是预演。加 --confirm 才会真正执行。将要做的："
        echo "    1. 停止融合侧消费者：${FUSION_CONSUMERS[*]}"
        echo "    2. 只复制所选方案 $SYSTEM：${PAIRS[*]}"
        echo "    4. 校验复制结果（逐文件哈希、权限、符号链接）"
        echo "    5. **不启动任何服务**；启动是独立的显式步骤"
        return 0
    fi
    if [ "$problems" -ne 0 ]; then
        echo "  检查未通过（$problems 项），拒绝执行还原。" >&2
        return 1
    fi

    echo "  1) 停止融合侧消费者（保留新系统配置与数据，不触碰 .openclaw-fusion）"
    local u stop_ok=1
    for u in "${FUSION_CONSUMERS[@]}" "${LEGACY_UNITS[@]}"; do
        if ! systemctl --user stop "$u.service"; then
            echo "     ✗ 停止 $u 失败；中止还原以免出现两个 QQ 消费者" >&2
            stop_ok=0
        fi
        local stopped
        stopped=$(systemctl --user show "$u.service" -p ActiveState --value 2>/dev/null)
        case "$stopped" in inactive|failed) ;; *) stop_ok=0; echo "服务 $u 未确认停止：$stopped" >&2;; esac
        printf '     %-14s -> %s\n' "$u" "$stopped"
    done
    if [ "$stop_ok" -ne 1 ]; then
        echo "  还原已中止（未复制任何内容）。请先人工处理上面的服务。" >&2
        return 1
    fi

    echo "  2) 复制还原（归档只读，不移动）"
    for pair in "${PAIRS[@]}"; do
        local src rest dst
        src=${pair%%:*}; rest=${pair#*:}; dst=${rest%%:*}
        mkdir -m 700 "$dst" || { echo "目标已存在或无法创建：$dst" >&2; return 1; }
        cp -a "$src/." "$dst/" || { echo "复制失败，保留未完成目录供检查：$dst" >&2; return 1; }
    done
    echo "  3) 校验复制结果（逐文件内容哈希 + 符号链接目标，两个目录都比）"
    local verify_failed=0
    for pair in "${PAIRS[@]}"; do
        local src=${pair%%:*}; rest=${pair#*:}; dst=${rest%%:*}; label=${rest#*:}
        local ms md
        ms=$(manifest_of "$src" | sha256sum) || return 1
        md=$(manifest_of "$dst" | sha256sum) || return 1
        printf '     %-14s 源清单=%s  目标清单=%s  %s\n' "$label" "$ms" "$md" \
            "$([ "$ms" = "$md" ] && echo '一致 ✓' || echo '不一致 ✗')"
        [ "$ms" = "$md" ] || { echo "     ✗ $label 复制后内容清单不一致（缺失或损坏），请人工核对" >&2; verify_failed=1; }
    done
    [ "$verify_failed" -eq 0 ] || return 1
    local dangling
    dangling=$(find "$LEGACY_DST" -type l ! -exec test -e {} \; -print 2>/dev/null | wc -l)
    echo "     还原后失效符号链接：$dangling 个"
    echo "     归档原件仍在：$LEGACY_SRC"
    ok "还原完成，内容清单逐文件一致。**没有启动任何服务。**"
}

print_next_steps() {
    echo
    echo "只还原所选方案；启动前先离线处理旧 Cron、外发白名单与暂停状态。"
    echo "旧 A、旧 B 只能选一个。新系统数据不会同步进旧系统。"
    echo "若旧单元已 mask，须在完成风险检查后显式 unmask 所选单元。"
    if [ "$SYSTEM" = A ]; then
        echo "A：确认融合及 qq-bridge 均停止后，才可执行："
        echo "  systemctl --user start openclaw-gateway.service"
    elif [ "$SYSTEM" = B ]; then
        echo "B：确认融合及 openclaw-gateway 均停止后，才可执行："
        echo "  sudo systemctl start dsh-web.service"
        echo "  systemctl --user start snowluma.service snowluma-qq.service"
        echo "  systemctl --user start qq-bridge.service"
    else
        echo "本次只检查；使用 --restore --system A 或 --system B 选择一种回退。"
    fi
    echo "返回融合：先停止所选旧消费者，再启动 kurumi-fusion、snowluma、snowluma-qq。"
    echo "离线复制校验不等于旧系统真实启动验收。本工具从不自动启动服务。"
}

# ---------------------------------------------------------------- main

echo "════ restore-legacy.sh  mode=$MODE ════"
echo "归档：$ARCHIVE"
echo "备份：$BACKUPS"
echo
check_archive
echo
check_backups
echo
check_targets
echo
check_services
echo
check_links_and_deps
echo
audit_legacy_state
echo
echo "【小结】问题 $problems 项，提醒 $warnings 项"

if [ "$MODE" = restore ]; then
    do_restore || exit 1
fi

print_next_steps

if [ "$MODE" = check ] && [ "$problems" -eq 0 ]; then
    exit 0
fi
[ "$problems" -eq 0 ] || exit 1
exit 0
