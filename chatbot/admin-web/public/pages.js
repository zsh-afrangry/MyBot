import {h, div, p, icon, chip, mono, muted, button, link, stack, heading, panel, empty, table, tabs, field, select,
  time, eventState, aligned, banner, markdown, dialog, notice} from './components.js';

const routeOf = (name, params = {}) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== null && value !== undefined && value !== ''));
  return name + (search.size ? '?' + search : '');
};
const auditLabel = {member: 'QQ 白名单', mail: '邮件收件人', persona: '人格素材'};
const operationLabel = {add: '新增', edit: '更新', remove: '移除'};
const serviceIcons = {fusion: 'layers', snowluma: 'link', onebot: 'user', dsh: 'command', km: 'bank', web: 'home'};
const sourceLabels = {on: ['已配置启用', 'green'], off: ['停用', 'neutral'], unconfigured: ['未配置', 'neutral'],
  unknown: ['不可核对', 'amber'], planned: ['需求', 'blue'], read: ['可查看', 'neutral']};
const sourceState = value => chip(...(sourceLabels[value] ?? sourceLabels.unknown));
const toggle = val => val === true ? chip('开启', 'green') : val === false ? chip('关闭') : chip('未获取', 'amber');
const action = label => div('row-name', h('strong', null, label));
const errorLine = () => h('p', {class: 'form-error', role: 'alert', hidden: true});
const showError = (el, error) => {el.textContent = error.message; el.hidden = false;};

function serviceChip(s, qq) {
  if (s.id === 'onebot' && qq) return qq.online && qq.good ? chip('QQ 在线', 'green') : chip(qq.online ? 'QQ 状态异常' : 'QQ 离线', 'red');
  if (s.reachable) return chip('端口可达', 'green');
  if (s.reachable === false) return chip('端口不可达', 'red');
  if (s.systemd.active === 'active') return chip('服务运行', 'green');
  if (s.systemd.active === 'failed') return chip('服务异常', 'red');
  return chip('未确认', 'amber');
}

function serviceRows(data) {
  return div('service-list', data.services.map(s => div('service-row',
    div('service-symbol', icon(serviceIcons[s.id] ?? 'system')),
    div('service-name', h('strong', null, s.name), h('small', null, s.detail)),
    div('service-port', mono(s.port ? ':' + s.port : '—')), serviceChip(s, data.qq))));
}

function changeRows(rows, full = false) {
  if (!rows.length) return div('quiet-empty', icon('clock'), '暂无从管理台保存的变更。');
  return div('activity', rows.map(row => div('activity-row', div('activity-icon', icon(row.kind === 'persona' ? 'soul' : 'shield')),
    div('activity-name', h('strong', null, (operationLabel[row.operation] ?? '变更') + ' · ' + (auditLabel[row.kind] ?? '设置')),
      h('small', null, row.target, full && row.sourceRevision ? ' · 修订 ' + row.sourceRevision : '')),
    h('time', {datetime: row.at}, time(row.at, !full)))));
}

function metric(label, value, detail, ico, tone, to) {
  return h('a', {class: 'metric', href: '#' + to},
    div('metric-top', div('metric-icon ' + tone, icon(ico)), icon('chevron', 'onhover')),
    h('strong', {class: 'metric-value'}, value ?? '—'),
    h('span', {class: 'metric-label'}, label), h('small', null, detail));
}

export async function overview({api}) {
  const data = await api('/overview');
  const qq = data.services.qq;
  const count = data.services.services.filter(s => s.reachable === true).length;
  return stack(
    div('hero',
      div('hero-graphics', div('orbit o1'), div('orbit o2'), div('orbit o3'),
        div('orbit-kernel', h('img', {src: '/mark.svg', alt: '', width: 88, height: 88})), div('orbit-dot a'), div('orbit-dot b'), div('orbit-dot c')),
      div('hero-copy',
        div('hero-kicker', h('i'), 'KURUMI FUSION / 01'),
        h('h1', null, 'Kurumi 管理台'),
        p('在一处查看她的世界：角色陪伴、工作助手与背后的运行服务。'),
        div('hero-actions', link('浏览项目地图', 'modules', {kind: 'hero-primary', arrow: true}), link('查看链路日志', 'logs', {kind: 'hero-secondary'})),
        div('hero-meta', data.release ? h('span', null, 'OpenClaw ', data.release) : null,
          data.model ? h('span', null, data.model) : null,
          h('span', null, h('i', {class: qq?.online && qq.good ? 'online-dot' : 'unknown-dot'}),
            qq?.online && qq.good ? 'QQ 在线' : qq ? 'QQ 状态需查看' : 'QQ 状态未探测')))),
    div('metrics',
      metric('本机端点可达', count + ' / ' + data.services.services.length, '查看服务与端口', 'system', 'rose', 'system'),
      metric('已启用插件', data.runtimeAvailable ? data.counts.plugins : null,
        data.runtimeAvailable ? data.counts.agents + ' 个运行 Agent' : '运行配置不可读', 'layers', 'lavender', 'modules'),
      metric('源配置身份', data.counts.identities, data.accessAligned === false ? '有身份变更待同步' : 'QQ 白名单与邮件收件人', 'shield', 'ochre', 'access'),
      metric('长期记忆', data.memory.available ? data.memory.facts : null,
        data.memory.available ? data.memory.summaries + ' 条有效近期摘要' : '记忆状态待核对', 'memory', 'mint', 'memory')),
    div('dashboard-grid',
      panel('运行拓扑', 'Fusion、QQ 和独立服务的本机状态', serviceRows(data.services), link('运行详情', 'system', {arrow: true})),
      stack(
        panel('待同步检查', '对照仓库意图与当前运行副本',
          div('check-list',
            h('a', {href: '#persona'}, div('', h('strong', null, '人格投影'), h('small', null, '主人和成员的受管文件')), aligned(data.personaAligned)),
            h('a', {href: '#access'}, div('', h('strong', null, '身份与收件人'), h('small', null, '仓库名单与运行策略')), aligned(data.accessAligned)))),
        panel('最近变更', '从本管理台保存的记录', changeRows(data.audit), link('全部', 'access/audit', {arrow: true})))),
    div('page-note', icon('clock'), '探测时间 ', time(data.services.at, true), ' · 北京时间'));
}

function rolePreview(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  let head = 0, tail = 0;
  while (head < Math.min(a.length, b.length) && a[head] === b[head]) head++;
  while (tail < Math.min(a.length, b.length) - head && a[a.length - tail - 1] === b[b.length - tail - 1]) tail++;
  const left = a.slice(head, a.length - tail), right = b.slice(head, b.length - tail);
  if (left.length * right.length > 65000 || left.length + right.length > 1200) {
    return div('compare-grid', div('', h('h3', null, '原文件'), h('pre', {class: 'compare-value'}, before)),
      div('', h('h3', null, '保存后'), h('pre', {class: 'compare-value'}, after)));
  }
  const size = right.length + 1, grid = new Uint16Array((left.length + 1) * size), rows = [];
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    grid[i * size + j] = left[i] === right[j] ? grid[(i + 1) * size + j + 1] + 1
      : Math.max(grid[(i + 1) * size + j], grid[i * size + j + 1]);
  }
  if (head) rows.push(div('diff-skip', '… ' + head + ' 行开头保持原样'));
  for (let i = 0, j = 0; i < left.length || j < right.length;) {
    if (i < left.length && j < right.length && left[i] === right[j]) {rows.push(div('diff-row', '  ' + left[i])); i++; j++;}
    else if (i < left.length && (j >= right.length || grid[(i + 1) * size + j] >= grid[i * size + j + 1])) {
      rows.push(div('diff-row minus', '− ' + left[i++]));
    } else rows.push(div('diff-row plus', '+ ' + right[j++]));
  }
  if (tail) rows.push(div('diff-skip', '… ' + tail + ' 行结尾保持原样'));
  return div('diff', rows);
}

function compared(before, after) {
  const show = v => v == null ? '（无）' : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return div('compare-grid', div('', h('h3', null, '修改前'), h('pre', {class: 'compare-value'}, show(before))),
    div('', h('h3', null, '保存后'), h('pre', {class: 'compare-value'}, show(after))));
}

async function confirmChange(ctx, input) {
  const preview = await ctx.api('/change/preview', input);
  const err = errorLine();
  const el = dialog('确认保存 · ' + preview.label, '请核对实际写入内容。预览自生成起 5 分钟内有效。',
    preview.kind === 'persona' ? rolePreview(preview.before, preview.after) : compared(preview.before, preview.after),
    banner('只保存到仓库', preview.sourceRevision
      ? '权限修订将更新到 ' + preview.sourceRevision + '。运行名单要按配置同步流程生效。'
      : '将修改选中的源素材。请按人格同步流程更新各工作区的受管文件。'),
    err, div('dialog-actions', button('取消', () => el.close(), {kind: 'ghost'}), button('确认保存', async event => {
      const btn = event.currentTarget;
      btn.disabled = true;
      err.hidden = true;
      try {
        const result = await ctx.api('/change/commit', {id: preview.id});
        el.close();
        notice(result.recorded ? '已保存到仓库 · 等待同步' : '源文件已保存，变更记录未能写入。', result.recorded ? '' : 'warning');
        ctx.reload();
      } catch (error) {showError(err, error);}
    }, {kind: 'primary', icon: 'check'})));
}

export async function persona(ctx) {
  const data = await ctx.api('/persona');
  const slot = data.slots.some(s => s.key === ctx.part) ? ctx.part : 'soul';
  const meta = data.slots.find(s => s.key === slot);
  if (!meta) return heading('配置 / 人格', '人格与关系', '暂无可用的共享角色素材。');
  const file = await ctx.api('/persona/' + slot);
  const editor = h('textarea', {id: 'role-editor', class: 'role-editor', spellcheck: 'false', value: file.text,
    'aria-label': 'Markdown 素材内容', maxlength: '65536'});
  const stats = h('span', {class: 'muted small'});
  const preview = div('role-read', markdown(file.text));
  preview.hidden = true;
  const err = errorLine();
  const save = button('预览变更', async () => {
    err.hidden = true;
    save.disabled = true;
    try {await confirmChange(ctx, {kind: 'persona', slot, revision: file.revision, personaRevision: file.personaRevision, text: editor.value});}
    catch (error) {showError(err, error);}
    finally {save.disabled = editor.value === file.text;}
  }, {kind: 'primary', icon: 'check', disabled: true});
  const stat = () => {
    save.disabled = editor.value === file.text;
    stats.textContent = editor.value.split('\n').length + ' 行 · ' + new TextEncoder().encode(editor.value).length + ' 字节' + (save.disabled ? '' : ' · 未保存');
  };
  editor.addEventListener('input', stat);
  stat();
  const modes = div('segmented');
  modes.append(button('编辑', () => {
    editor.hidden = false; preview.hidden = true;
    modes.dataset.reading = 'no'; editor.focus();
  }), button('阅读预览', () => {
    preview.replaceChildren(markdown(editor.value)); editor.hidden = true; preview.hidden = false;
    modes.dataset.reading = 'yes';
  }));

  return stack(
    heading('配置 / 角色陪伴', '人格与关系', data.identity + ' 的角色卡与关系素材。共享人格与按身份投影的关系在同一处查看。', aligned(data.aligned)),
    tabs(data.slots.map(s => [s.key, s.label]), slot, id => 'persona/' + id),
    div('detail-grid',
      panel(meta.target, null, stack(
        div('editor-header', mono(file.source), modes),
        editor, preview, err,
        div('action-line', stats, div('actions', button('还原编辑', () => {
          editor.value = file.text; if (!preview.hidden) preview.replaceChildren(markdown(file.text)); stat();
        }, {kind: 'ghost'}), save))),
      chip('Markdown')),
      stack(
        panel('人格投影', '按身份核对四份受管文件', projectionList(data.workspaces)),
        panel('生效方式', '修改的是配置声明选中的源素材。', stack(
          p('SOUL 面向所有已登记身份；主人和成员关系分别投影到各自的 USER.md。', 'small muted'),
          p('保存后核对差异，确认后用现有人格同步流程应用。', 'small muted'),
          h('pre', {class: 'command'}, 'node scripts/fusion/sync-persona.mjs --diff'),
          link('查看人格契约', 'modules/doc/25', {arrow: true}))))));
}

function projectionList(workspaces) {
  if (!workspaces.length) return p('源配置无法生成投影。请用人格同步命令核对。', 'small muted');
  const status = {match: () => chip('已同步', 'green'), different: () => chip('待同步', 'amber'),
    missing: () => chip('未投影', 'amber'), unavailable: () => chip('未读取', 'amber')};
  return div('agent-list', workspaces.map((workspace, i) =>
    h('details', {open: i === 0}, h('summary', null, h('strong', null, workspace.label), icon('down', 'detail-arrow')),
      div('plain-rows', workspace.files.map(row =>
        div('plain-row', div('inline', icon('file'), mono(row.name)), status[row.state]()))))));
}

const permissionLabels = {'chat.use': '使用私聊', 'commands.basic': '基本命令', 'search.use': '搜索与抓取',
  'qq.reply': '接收文本回复', 'qq.file.reply': '接收文件回复', 'qq.notify': '接收通知',
  'papers.import': '导入论文', 'papers.read': '查看论文', 'papers.translate': '翻译论文', 'papers.cancel': '取消翻译'};
const active = r => !r?.enabled ? chip('停用') : r.expiresAt && Date.parse(r.expiresAt) <= Date.now()
  ? chip('已到期', 'amber') : !r.permissions?.['chat.use'] ? chip('无私聊准入') : chip('启用', 'green');

function datetimeLocal(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16);
}

function memberForm(ctx, data, row = null) {
  const input = h('input', {type: 'text', inputmode: 'numeric', pattern: '[0-9]{5,12}', required: true,
    maxlength: '12', value: row?.qq ?? '', readOnly: row ? true : undefined, placeholder: '5–12 位数字'});
  const enabled = h('input', {type: 'checkbox', checked: row?.enabled ?? false});
  const note = h('textarea', {rows: '2', maxlength: '500', value: row?.note ?? '', placeholder: '可选：例如便于识别的称呼'});
  const expires = h('input', {type: 'datetime-local', value: datetimeLocal(row?.expiresAt)});
  const permissionInputs = data.sharedPermissions.map(perm =>
    [perm, h('input', {type: 'checkbox', checked: row?.permissions?.[perm] === true})]);
  const err = errorLine();
  const el = dialog(row ? '编辑成员' : '新增 QQ 成员',
    row ? '按 QQ 号维护此成员。主人及群聊准入不在这张表单内。' : '请显式选权限和是否启用。新成员初始不授予任何权限。');
  const submit = button('预览变更', undefined, {submit: true, kind: 'primary', icon: 'arrow'});
  el.querySelector('.dialog-body').append(h('form', {onsubmit: async event => {
    event.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      const original = datetimeLocal(row?.expiresAt);
      const nextExpiry = original === expires.value ? row?.expiresAt ?? null : expires.value ? expires.value + ':00+08:00' : null;
      await confirmChange(ctx, {kind: 'member', operation: row ? 'edit' : 'add', qq: input.value.trim(), revision: data.revision,
        enabled: enabled.checked, note: note.value, expiresAt: nextExpiry, permissions: permissionInputs.filter(([, c]) => c.checked).map(([key]) => key)});
    } catch (error) {showError(err, error);}
    finally {submit.disabled = false;}
  }}, div('form-stack',
    div('form-columns', field('QQ 号', input), field('到期时间（北京时间）', expires, '留空为不过期')),
    field('备注', note), h('label', {class: 'check-item'}, enabled, h('span', null, '启用此身份')),
    h('fieldset', {class: 'permission-grid'}, h('legend', null, '可分配的共享权限'), permissionInputs.map(([key, control]) =>
      h('label', {class: 'check-item permission'}, control, div('', permissionLabels[key] ?? key, h('small', null, key))))),
    err, div('dialog-actions', button('取消', () => el.close(), {kind: 'ghost'}), submit))));
}

function emailForm(ctx, data, addr = null) {
  const input = h('input', {type: 'email', required: true, maxlength: '254', value: addr ?? '', placeholder: 'name@example.com'});
  const err = errorLine();
  const el = dialog(addr ? '更新邮件收件人' : '新增邮件收件人', '按完整邮箱地址维护。保存名单不会发送邮件。');
  const submit = button('预览变更', undefined, {submit: true, kind: 'primary', icon: 'arrow'});
  el.querySelector('.dialog-body').append(h('form', {onsubmit: async event => {
    event.preventDefault(); submit.disabled = true; err.hidden = true;
    try {
      await confirmChange(ctx, {kind: 'mail', operation: addr ? 'edit' : 'add', address: addr,
        nextAddress: input.value, revision: data.revision});
    } catch (error) {showError(err, error);}
    finally {submit.disabled = false;}
  }}, div('form-stack', field('邮箱地址', input), err,
    div('dialog-actions', button('取消', () => el.close(), {kind: 'ghost'}), submit))));
}

function permissionMatrix(data) {
  const names = data.rows.map(r => r.source);
  const sourceLabel = perm => permissionLabels[perm] ?? perm;
  const filter = h('input', {type: 'search', placeholder: '搜索权限名…', 'aria-label': '搜索权限名'});
  const content = div('');
  const update = () => {
    const term = filter.value.trim().toLowerCase();
    const filtered = data.permissions.filter(perm => (perm + ' ' + sourceLabel(perm)).toLowerCase().includes(term));
    content.replaceChildren(table(['权限键', '类别', ...names.map(row => row.role === 'owner' ? '主人' : row.qq)], filtered.map(perm =>
      [div('row-title', mono(perm), permissionLabels[perm] ? h('small', null, sourceLabel(perm)) : null),
        data.sharedPermissions.includes(perm) ? chip('共享', 'blue') : chip('主人专用'),
        ...names.map(row => row.permissions[perm] ? chip('允许', 'green') : muted('—'))])));
  };
  filter.addEventListener('input', update); update();
  return panel('权限矩阵', '展示仓库声明。实际准入还取决于启用状态、到期时间和宿主工具上限。', content, filter);
}

function protectedLists(data) {
  const status = (list, value) => !list ? chip('未读取', 'amber') : list.includes(value) ? chip('已登记', 'green') : chip('未登记');
  const list = (title, detail, entry) => panel(title, detail, table(['条目', '仓库', '运行副本'],
    [...new Set([...(entry.source ?? []), ...(entry.runtime ?? [])])].sort().map(value =>
      [mono(value), status(entry.source, value), status(entry.runtime, value)]),
    entry.source && entry.runtime ? '没有附加条目' : '未读取到名单'), aligned(entry.aligned));
  const projectCell = (list, row) => !list ? chip('未读取', 'amber') : !row ? chip('未登记') :
    div('row-title', mono(row.root), h('small', null, row.branch ? 'Git · ' + row.branch : '目录'),
      row.checks.length ? h('small', null, row.checks.join(' · ')) : null);
  const {source, runtime, aligned: projectsAligned} = data.projects;
  const ids = [...new Set([...(source ?? []).map(p => p.id), ...(runtime ?? []).map(p => p.id)])].sort();
  return stack(
    list('主人附加工具', '显式登记的工具名。实际执行仍受宿主和业务权限限制。', data.tools),
    list('额外可写目录', '原生 exec 围栏的附加根。', data.directories),
    panel('登记的编码项目', '对照目录、目标分支与检查项。', table(['项目 ID', '仓库', '运行副本', '同步状态'], ids.map(id => {
      const a = source?.find(p => p.id === id), b = runtime?.find(p => p.id === id);
      return [mono(id), projectCell(source, a), projectCell(runtime, b),
        aligned(source && runtime ? JSON.stringify(a) === JSON.stringify(b) : null)];
    }), source && runtime ? '没有登记的项目' : '未读取到项目'), aligned(projectsAligned)));
}

export async function access(ctx) {
  const view = ['members', 'recipients', 'managed', 'matrix', 'audit'].includes(ctx.part) ? ctx.part : 'members';
  if (view === 'audit') {
    const data = await ctx.api('/audit');
    return stack(heading('配置 / 变更记录', '变更记录', '最近 50 条管理台的源文件保存记录。'), accessTabs(view),
      panel('保存记录', '由本管理台记录，目标地址和 QQ 标识最小化展示。', changeRows(data.rows, true)));
  }
  if (view === 'managed') {
    const data = await ctx.api('/whitelist/managed');
    return stack(heading('配置 / 访问控制', '身份与白名单', '核对工具权限、可写目录与编码项目的仓库声明和运行副本。'),
      accessTabs(view), protectedLists(data), link('查看受管名单的维护规则', 'modules/doc/24', {arrow: true}));
  }
  const data = await ctx.api('/whitelist');
  const remove = async (kind, value) => {
    try {await confirmChange(ctx, {kind, operation: 'remove', revision: data.revision, ...(kind === 'member' ? {qq: value} : {address: value})});}
    catch (error) {notice(error.message, 'warning');}
  };
  const drift = data.aligned === true ? null : banner('源配置与运行副本', data.runtimeRevision === null
    ? '没有读到有效的运行策略；当前只显示仓库配置。'
    : '这里保存仓库意图。先审阅配置差异，按同步流程应用，成员工作区按身份管理契约准备。', 'warning');

  let content;
  if (view === 'recipients') {
    const owner = data.rows.find(r => r.source.role === 'owner');
    const now = owner?.source.mailRecipients ?? [];
    const eff = owner?.effective?.mailRecipients ?? null;
    const addresses = [...new Set([...now, ...(eff ?? [])])];
    content = panel('邮件收件人', '主人可用的 SMTP 精确地址白名单。', table(['邮件地址', '仓库', '运行副本', '操作'],
      addresses.map(address => [mono(address), now.includes(address) ? chip('已登记', 'green') : chip('已移除', 'amber'),
        eff === null ? chip('未读取') : eff.includes(address) ? chip('已登记', 'green') : chip('未登记'),
        now.includes(address) ? div('actions',
          button('编辑', () => emailForm(ctx, data, address), {kind: 'ghost small-button', icon: 'edit'}),
          button('移除', () => remove('mail', address), {kind: 'danger-text small-button'})) : muted('待同步')]),
      '收件人白名单为空'), button('新增收件人', () => emailForm(ctx, data), {kind: 'primary', icon: 'plus'}));
  } else if (view === 'matrix') content = permissionMatrix(data);
  else content = panel('QQ 身份', '新增、编辑和移除普通成员。移除只影响名单登记，会话和资料仍保留。', table(
    ['QQ 身份', '源状态', '权限', '到期时间', '运行对照', '操作'], [
      ...data.rows.map(({source: row, aligned: synced}) => [
        div('row-title', h('strong', null, row.qq, ' ', chip(row.role === 'owner' ? '主人' : row.kind === 'group' ? '群登记' : '成员', row.role === 'owner' ? 'rose' : 'neutral')),
          row.note ? h('small', null, row.note) : null),
        active(row), Object.values(row.permissions).filter(v => v === true).length + ' 项', row.expiresAt ? time(row.expiresAt) : '不过期',
        aligned(synced), row.role !== 'owner' && row.kind === 'user' ? div('actions',
          button('编辑', () => memberForm(ctx, data, row), {kind: 'ghost small-button', icon: 'edit', aria: '编辑成员 ' + row.qq}),
          button('移除', () => remove('member', row.qq), {kind: 'danger-text small-button', aria: '移除成员 ' + row.qq})) : muted('受保护'),
      ]),
      ...data.removed.map(row => [mono(row.qq), chip('源已移除', 'amber'), '—', '—', chip('运行仍有登记', 'amber'), muted('待同步')]),
    ]), button('新增成员', () => memberForm(ctx, data), {kind: 'primary', icon: 'plus'}));

  return stack(
    heading('配置 / 访问控制', '身份与白名单', '管理 QQ 成员与邮件收件人，核对权限和运行状态。', aligned(data.aligned)),
    div('inline version-note', chip('仓库修订 ' + data.sourceRevision), chip('运行修订 ' + (data.runtimeRevision ?? '未知')),
      link('权限契约', 'modules/doc/24', {arrow: true})),
    accessTabs(view), drift, content);
}

const accessTabs = view => tabs([['members', 'QQ 身份'], ['recipients', '邮件收件人'], ['managed', '受管名单'], ['matrix', '权限矩阵'], ['audit', '变更记录']],
  view, id => 'access/' + id);

function noteList(items, type, revealed) {
  if (!items.length) return empty(type === 'summary' ? '暂无有效的近期摘要' : '暂无长期记忆', '这里显示现在可被使用的记忆。', 'memory');
  return div('note-list', items.map(item => h('details', {class: 'note-row'},
    h('summary', null, div('note-icon', icon(type === 'summary' ? 'clock' : 'memory')), div('note-main',
      h('strong', null, revealed ? item.text : item.id),
      h('small', null, (item.kind === 'preference' ? '偏好' : item.kind === 'interaction_summary' ? '近期摘要' : '事实') + ' · ' + time(item.updatedAt))),
    icon('down', 'detail-arrow')),
    div('note-detail', h('dl', {class: 'data-pairs'},
      h('dt', null, '记录 ID'), h('dd', null, mono(item.id)),
      h('dt', null, '来源'), h('dd', null, item.source === 'legacy_explicit' ? '历史显式记忆' : '本人私聊'),
      h('dt', null, '建立时间'), h('dd', null, time(item.createdAt)),
      item.expiresAt ? [h('dt', null, '到期时间'), h('dd', null, time(item.expiresAt))] : null)))));
}

export async function memory(ctx) {
  const revealed = ctx.params.get('content') === '1';
  const type = ctx.part === 'summaries' ? 'summaries' : 'facts';
  const data = await ctx.api('/memory' + (revealed ? '?content=1' : ''));
  const page = heading('数据 / 会话连续性', '记忆', '管理台呈现 Kurumi 当下可用的长期事实、偏好和有期限的摘要。',
    data.version ? chip(data.version + ' · 只读', 'rose') : chip('只读'));
  if (!data.available) return stack(page, panel('当前记忆', null, empty('无法读取记忆', data.reason, 'memory')));
  const list = div('');
  const filter = h('input', {type: 'search', placeholder: '筛选记忆内容…', 'aria-label': '筛选记忆内容'});
  const rows = type === 'summaries' ? data.summaryItems : data.factItems;
  const update = () => {
    const q = filter.value.trim().toLowerCase();
    list.replaceChildren(noteList((rows ?? []).filter(item => !q || [item.id, item.text].some(v => v?.toLowerCase().includes(q))), type === 'summaries' ? 'summary' : 'fact', revealed));
  };
  if (revealed) {filter.addEventListener('input', update); update();}
  const to = (key, content) => routeOf('memory/' + key, {content: content ? '1' : null});
  return stack(page, div('metrics metrics-three',
    metric('长期事实与偏好', data.facts, '已保存的有效条目', 'memory', 'rose', to('facts', revealed)),
    metric('有效近期摘要', data.summaries, '默认保留 ' + data.ttl + ' 天', 'clock', 'lavender', to('summaries', revealed)),
    metric('修订', data.revision, '记忆代次 ' + data.generation, 'layers', 'mint', to(type, revealed))),
    tabs([['facts', '长期事实'], ['summaries', '近期摘要']], type, key => to(key, revealed)),
    panel(type === 'facts' ? '长期事实与偏好' : '近期摘要', type === 'facts' ? '与 QQ 原始会话分开保存。' : '只列未到期摘要，' + data.expired + ' 条到期记录不在列表内。',
      revealed ? list : empty('内容已隐藏', '开启后可在这个页面查看记忆内容。离开记忆页面后可再次隐藏。', 'shield'),
      div('actions', revealed ? filter : null, link(revealed ? '隐藏内容' : '显示内容', to(type, !revealed),
        {kind: revealed ? 'ghost' : 'primary', icon: revealed ? 'shield' : 'key'}))),
    banner('记忆操作边界', '记住、更正与遗忘由 Kurumi 的本人私聊工作流处理。这里不提供聊天原文，也不会修改、迁移或重建记忆库。'));
}

const logKeys = {runId: 'Run ID', cronJobId: 'Cron ID', taskId: '任务 ID'};
function detailLog(row, labels, params) {
  const keys = Object.entries(row.correlation);
  const jumps = Object.keys(logKeys).filter(key => row.correlation[key]).map(key =>
    link('跟踪 ' + logKeys[key], routeOf('logs', {
      hours: params.get('hours') ?? 2, [key]: row.correlation[key],
    }), {arrow: true}));
  const el = dialog('链路事件详情', (labels[row.source] ?? row.source) + ' · ' + time(row.at, true),
    h('dl', {class: 'data-pairs'}, [['类型', row.kind], ['工具', row.tool], ['状态', row.status],
      ['错误码', row.code], ['级别', row.level], ['用时', row.duration == null ? null : row.duration + ' ms'], ['事件引用', row.ref],
      ...keys].filter(([, value]) => value !== null && value !== undefined).map(([key, value]) =>
      [h('dt', null, key), h('dd', null, mono(value))])),
    jumps.length ? div('action-line', div('actions', jumps)) : null);
  el.querySelectorAll('a').forEach(anchor => anchor.addEventListener('click', () => el.close()));
}

export async function logs(ctx) {
  const param = ctx.params;
  const [sources, data] = await Promise.all([
    ctx.api('/log-sources'),
    ctx.api('/logs?' + param).then(value => ({value}), error => ({error})),
  ]);
  const labels = Object.fromEntries(sources);
  const period = select([['1', '近 1 小时'], ['2', '近 2 小时'], ['6', '近 6 小时'], ['24', '近 24 小时'], ['72', '近 3 天'], ['168', '近 7 天']],
    param.get('hours') ?? '2');
  const focus = select([['', '全部来源'], ...sources], param.get('source') ?? '');
  const view = select([['events', '全部事件'], ['errors', '失败与警告']], param.get('view') ?? 'events');
  const q = h('input', {type: 'search', placeholder: '类型、错误码、关联 ID…', maxlength: '125', value: param.get('q') ?? ''});
  const key = Object.keys(logKeys).find(key => param.has(key));
  const form = h('form', {class: 'filters', onsubmit: event => {
    event.preventDefault();
    ctx.go(routeOf('logs', {hours: period.value, source: focus.value, view: view.value, q: q.value.trim(),
      ...(key ? {[key]: param.get(key)} : {})}));
  }}, field('时间范围', period), field('来源', focus), field('视图', view), field('检索元数据', q),
    button('查找', undefined, {submit: true, kind: 'primary', icon: 'search'}));
  let results;
  if (data.error) results = panel('查询结果', null,
    empty('无法加载日志', data.error.message, 'warning'),
    button('重试', ctx.reload, {icon: 'refresh'}));
  else {
    const value = data.value, offset = Number(param.get('offset') ?? 0);
    const rows = value.entries.map(row => [
      h('time', {datetime: row.at}, time(row.at, true)), chip(labels[row.source] ?? row.source),
      div('row-title', mono(row.kind), row.tool || row.code ? h('small', null, [row.tool, row.code].filter(Boolean).join(' · ')) : null),
      eventState(row.status ?? row.level), button('详情', () => detailLog(row, labels, param), {kind: 'ghost small-button', icon: 'chevron'}),
    ]);
    const page = next => routeOf('logs', {...Object.fromEntries(param), to: value.to, offset: next});
    results = panel('链路事件', '技术元数据 · 北京时间', stack(
      value.scanLimited ? banner('命中范围受限', '关键词扫描最多取此时间窗内最新的 1,500 条错误。', 'warning') : null,
      table(['时间', '来源', '事件', '状态', '详情'], rows, '所选范围没有匹配的日志'),
      div('table-footer', h('span', {class: 'muted small'}, value.entries.length
        ? '显示 ' + (offset + 1) + '–' + (offset + value.entries.length) + ' / ' + value.count + ' 条' : '共 ' + value.count + ' 条'),
      div('actions', offset > 0 ? link('上一页', page(Math.max(0, offset - 45))) : null,
        value.next !== null && value.next <= 20000 ? link('下一页', page(value.next), {arrow: true}) : null)),
      value.sourceStatus.length ? h('details', {class: 'sources'}, h('summary', null, '查看来源读取情况'),
        div('tag-wall', value.sourceStatus.map(s => chip((labels[s.source] ?? s.source) + (s.partial || s.unavailable
          ? ' · ' + (s.available ? '部分可读' : '缺少或不可用') : ' · 可读'), s.partial || s.unavailable ? 'amber' : 'green')))) : null),
    chip(value.count + ' 条', 'rose'));
  }
  return stack(heading('运维 / 可观测性', '链路日志', '筛选宿主、QQ 投递、业务与任务记录，按关联 ID 追踪异常。'),
    panel('筛选范围', '不展示消息正文、工具输入输出或凭据。', stack(form,
      key ? div('inline', chip(logKeys[key] + ' · ' + param.get(key), 'blue'),
        link('清除关联筛选', routeOf('logs', {hours: period.value, source: focus.value, view: view.value, q: q.value}))) : null)),
    results);
}

const taskViews = [['cron', '定时任务'], ['runs', '宿主运行'], ['coding', '编码委托'], ['reminders', '个人提醒'],
  ['mail', '邮件草稿'], ['papers', '论文翻译'], ['documents', '受管文件']];
const taskConfig = {
  cron: ['OpenClaw 调度', '筛查最近一次执行结果和下次执行时间。从 Cron ID 进入关联日志。'],
  runs: ['宿主任务记录', '包括宿主已记录的后台任务和 Cron 运行。投递与执行分别显示。'],
  coding: ['编码任务', '查看编码委托的稳定编号、项目和状态。'],
  reminders: ['一次性提醒', '按排期查看提醒状态与失败码。'],
  mail: ['邮件草稿', '查看草稿生命周期。正文、附件和 SMTP 响应不在此展示。'],
  papers: ['论文翻译任务', '查看最近更新的任务、投递状态和关联链路。'],
  documents: ['受管文件索引', '查看 PDF 与其他受管文档的元数据编号。'],
};

function taskTable(data, kind) {
  const logLink = (key, value) => value ? link('查日志', routeOf('logs', {hours: 168, [key]: value}), {arrow: true}) : muted('无关联 ID');
  if (kind === 'cron') return table(['任务 / ID', '启停', '上次结果', '上次 / 下次（北京）', '链路'], data.map(r => [
    div('row-title', h('strong', null, r.name ?? r.type ?? '定时任务'), h('small', null, r.id)), toggle(r.enabled),
    div('tag-wall', eventState(r.status), r.delivery ? eventState(r.delivery) : null),
    div('row-title', h('small', null, '上次 ', time(r.last)), h('small', null, '下次 ', time(r.next))), logLink('cronJobId', r.id),
  ]));
  if (kind === 'runs') return table(['任务 / 类型', 'Agent', '执行状态', '投递状态', '开始记录', '链路'], data.map(r => [
    div('row-title', mono(r.id), h('small', null, [r.type, r.kind].filter(Boolean).join(' · '))), mono(r.agent),
    eventState(r.status), eventState(r.delivery), time(r.created), logLink('runId', r.runId),
  ]));
  if (kind === 'coding') return table(['任务 ID', '登记项目', '状态', '创建时间'], data.map(r => [
    mono(r.id), mono(r.project), eventState(r.status), time(r.created),
  ]));
  if (kind === 'reminders') return table(['提醒 ID', '状态', '执行计划', '失败码'], data.map(r => [
    mono(r.id), eventState(r.status), time(r.scheduled), mono(r.code),
  ]));
  if (kind === 'mail') return table(['草稿 ID', '状态', '创建时间', '发送时间'], data.map(r => [
    mono(r.id), eventState(r.status), time(r.created), time(r.sent),
  ]));
  if (kind === 'papers') return table(['任务 / 文档', '翻译状态', '投递状态', '最后更新', '链路'], data.map(r => [
    div('row-title', mono(r.id), r.document ? h('small', null, r.document) : null),
    eventState(r.status), eventState(r.delivery), time(r.updated), logLink('taskId', r.id),
  ]));
  return table(['文档 ID', '类型'], data.map(r => [mono(r.id), chip(r.type)]));
}

export async function tasks(ctx) {
  const key = Object.hasOwn(taskConfig, ctx.part) ? ctx.part : 'cron';
  const data = await ctx.api('/ops/' + key);
  const [title, description] = taskConfig[key];
  return stack(heading('运维 / 异步状态', '任务与调度', '查看 OpenClaw 调度、宿主运行和各领域的任务账本。'),
    tabs(taskViews, key, id => 'tasks/' + id),
    panel(title, description, data.available ? taskTable(data.rows, key) : empty('此数据源暂不可用',
      data.reason === 'not_configured' ? '运行配置没有登记对应目录。' : '没有可读取的账本，或账本结构与当前版本不一致。'),
      data.available ? chip(data.total + ' 条' + (data.total > data.rows.length ? ' · 显示 ' + data.rows.length : ''), 'rose') : null),
    banner('只读视图', '列表来自已存在的任务和投递记录。不会触发、取消、重跑任务或发送消息。'));
}

function docRow(doc) {
  const tone = doc.status === '已完成' ? 'green' : doc.status === '开发中' ? 'amber' : 'blue';
  return h('a', {class: 'doc-row', href: '#modules/doc/' + doc.id}, div('doc-id', String(doc.id).padStart(2, '0')),
    div('', h('strong', null, doc.title), h('small', null, doc.scope || '项目文档')), chip(doc.status, tone), icon('chevron'));
}

export async function modules(ctx) {
  if (ctx.part.startsWith('doc/')) {
    const data = await ctx.api('/docs/' + ctx.part.slice(4));
    return stack(link('返回项目地图', 'modules', {kind: 'ghost back-link'}), heading('项目文档 / ' + data.id, data.title, null, chip(data.status, 'rose')),
      panel('仓库文档', data.file, markdown(data.text), null, 'document-panel'));
  }
  const data = await ctx.api('/inventory');
  const groupRows = data.tree.flatMap(group => group.rows);
  const listMode = ctx.part === 'docs';
  const unfinished = data.docs.filter(doc => ['需求', '开发中'].includes(doc.status)).length;
  const selected = groupRows.find(row => row.key === ctx.part) ?? groupRows.find(row => row.key === 'host') ?? groupRows[0];
  const detail = selected ? panel(selected.label, '配置及运行接入情况', stack(
    selected.plugins.length ? table(['插件', '仓库声明', '运行声明'], selected.plugins.map(id => {
      const pl = data.plugins.find(p => p.id === id);
      return [mono(id), sourceState(pl?.source), sourceState(pl?.runtime)];
    })) : p('这个模块没有专用插件入口，详见对应说明。', 'muted small'),
    selected.documents.length ? div('doc-list', data.docs.filter(doc => selected.documents.includes(doc.id)).map(docRow)) : null,
    selected.page ? link('进入对应页面', selected.page, {kind: 'secondary', arrow: true}) : null), sourceState(selected.state)) : empty('没有读取到模块');
  const tree = panel('模块导航', '按产品职责查看', div('module-tree', data.tree.map(group =>
    h('details', {open: true}, h('summary', null, icon('down'), group.name),
      group.rows.map(row => h('a', {href: '#modules/' + row.key, class: row.key === selected?.key ? 'is-current' : ''},
        h('span', null, row.label), h('i', {class: 'tree-status ' + row.state, title: sourceLabels[row.state]?.[0]})))))));
  return stack(heading('系统 / 功能地图', '项目地图', '从角色、个人业务到宿主与外部服务，浏览整个项目的组成和对应文档。',
    div('tag-wall', chip(data.docs.length + ' 份编号文档', 'rose'), chip(unfinished + ' 项未完成', 'amber'))),
    tabs([['tree', '模块树'], ['docs', '文档索引']], listMode ? 'docs' : 'tree', key => key === 'tree' ? 'modules' : 'modules/docs'),
    listMode ? panel('编号文档', '从当前仓库读取标题与状态。', div('doc-list', data.docs.map(docRow)))
      : div('map-grid', tree, detail));
}

function systemList(data) {
  return div('endpoint-grid', data.services.map(s => div('endpoint',
    div('endpoint-head', div('service-symbol', icon(serviceIcons[s.id])), serviceChip(s, data.qq)),
    h('h3', null, s.name), p(s.detail, 'small muted'),
    div('endpoint-meta', mono(s.port ? '127.0.0.1:' + s.port : '端口未读取'), s.wsPort ? chip('WS ' + s.wsPort) : null),
    div('endpoint-foot', h('small', null, s.systemd.loaded ? 'systemd · ' + (s.systemd.active ?? '未知') : 'systemd 未确认'),
      s.url ? h('a', {href: s.url, class: 'mini-link', rel: 'noopener noreferrer', target: '_blank'}, '打开 ', icon('external')) : null))));
}

function pluginTable(data) {
  const container = div('');
  const search = h('input', {type: 'search', placeholder: '搜索插件…', 'aria-label': '搜索插件'});
  const show = () => {
    const q = search.value.trim().toLowerCase();
    container.replaceChildren(table(['插件 ID', '维护方', '仓库声明', '运行配置'], data.plugins.filter(pl => pl.id.toLowerCase().includes(q)).map(pl => [
      mono(pl.id), pl.origin, sourceState(pl.source), sourceState(pl.runtime),
    ])));
  };
  search.addEventListener('input', show); show();
  return panel('插件清单', '运行配置列是宿主配置声明，单个插件的加载结果请到链路日志检查。', container, search);
}

function agentTable(data) {
  return panel('运行 Agent', '工具列显示该 Agent 的配置值。宿主授权与业务权限会进一步限制执行。', data.agents.length ?
    div('agent-list', data.agents.map(agent => h('details', null, h('summary', null, div('', mono(agent.id),
      h('small', null, agent.model ?? '模型未声明')), chip(agent.role, 'rose'), icon('down', 'detail-arrow')),
      div('agent-policy', [['allow', '允许列表'], ['alsoAllow', '附加允许'], ['deny', '禁用列表']].map(([key, title]) =>
        div('', h('h3', null, title), agent[key].length ? div('tag-wall', agent[key].map(v => mono(v))) : p('未声明', 'small muted')))))))
    : empty('运行 Agent 未读取'));
}

export async function system(ctx) {
  const current = ['services', 'plugins', 'agents'].includes(ctx.part) ? ctx.part : 'services';
  const [data, svc] = await Promise.all([ctx.api('/inventory'), current === 'services' ? ctx.api('/services') : Promise.resolve(null)]);
  return stack(heading('运维 / 主机与配置', '运行配置', '核对本机端口、插件、模型和 Agent 的配置状态。'),
    tabs([['services', '本机服务'], ['plugins', '已知插件'], ['agents', 'Agent 与工具']], current, key => 'system/' + key),
    current === 'agents' ? agentTable(data) : current === 'plugins' ? pluginTable(data) : stack(
      panel('服务状态', '探测时间 ' + time(svc.at, true) + ' · 北京时间。端口可达表示本机 TCP 连接成功。', systemList(svc)),
      panel('运行摘要', '从 OpenClaw 运行配置中读取明确登记的设置。', div('summary-grid',
        ...[['固定内核版本', data.release], ['主模型', data.model], ['网页搜索', data.integrations.searchProvider],
          ['提醒列表来源', data.integrations.listSource], ['QQ 私聊频道', toggle(data.integrations.qq)], ['P2 连续性', toggle(data.integrations.memory)],
          ['验收入口', toggle(data.integrations.testIngress)], ['Code Mode', toggle(data.integrations.codeMode)]].map(([label, val]) =>
          div('', h('small', null, label), typeof val === 'string' || val == null ? mono(val) : val)))),
      banner('配置生效', '仓库配置与运行文件各有用途。管理台的保存动作只改源文件，配置同步、重启和备份恢复由 Fusion 的运维入口执行。')));
}
