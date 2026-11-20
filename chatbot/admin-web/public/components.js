const icons = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="4" rx="1.3"/><rect x="14" y="11" width="7" height="10" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/>',
  soul: '<path d="M12 2c.8 5.7 3.5 8.7 9 10-5.5 1.3-8.2 4.3-9 10-.8-5.7-3.5-8.7-9-10 5.5-1.3 8.2-4.3 9-10Z"/><path d="M19 2v4m-2-2h4"/>',
  memory: '<path d="M5 4h12a2 2 0 0 1 2 2v14H6a2 2 0 1 1 0-4h13M6 4a2 2 0 0 0-2 2v12m4-9h7m-7 3h5"/>',
  shield: '<path d="M12 22s7-3 7-9V5l-7-3-7 3v8c0 6 7 9 7 9Z"/><path d="m9 12 2 2 4-4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
  task: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 3h6v4H9zm0 9 2 2 4-4m-6 7h6"/>',
  logs: '<path d="M4 18V6m0 12h16M7 14l3-4 3 2 4-6 3 2"/>',
  system: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01m0 9h.01M12 7.5h6m-6 9h6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  external: '<path d="M13 5h6v6m0-6-9 9m-2-8H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.66L21 9m0-5v5h-5"/>',
  logout: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5m3-12 4 4-4 4m-5-4h13"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-3 3 3 3m-5-1 2 2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  edit: '<path d="m4 16-1 5 5-1L20 8l-4-4L4 16Zm10-10 4 4"/>',
  file: '<path d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6m-6 4h6"/>',
  bank: '<path d="m3 9 9-6 9 6H3Zm2 2v7m5-7v7m4-7v7m5-7v7M3 21h18"/>',
  link: '<path d="M9 15l6-6m2 5 3-3a4 4 0 0 0-6-6l-3 3m2 8-3 3a4 4 0 0 1-6-6l3-3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  warning: '<path d="M12 3 2 20h20L12 3Zm0 6v5m0 3h.01"/>',
  inbox: '<path d="M4 10 7 4h10l3 6v9H4v-9Zm0 1h5l1 3h4l1-3h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2"/>',
  command: '<path d="M4 6h16v12H4zm3 4 2 2-2 2m5 0h4"/>',
  git: '<circle cx="6" cy="5" r="2.3"/><circle cx="6" cy="19" r="2.3"/><circle cx="18" cy="9" r="2.3"/><path d="M6 7.3v9.4M18 11.3c0 3.3-2.6 5.4-6 5.4H8.3"/>',
  dots: '<path d="M5 12h.01m7 0h.01m7 0h.01" stroke-width="3"/>',
};

export function icon(name, cls = '') {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.65');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('class', 'icon ' + cls);
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = icons[name] ?? icons.dots; // Fixed local glyphs, never application data.
  return el;
}

export const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'checked' || key === 'selected' || key === 'value') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  const append = value => {
    if (value === null || value === undefined || value === false) return;
    if (Array.isArray(value)) value.forEach(append);
    else if (value instanceof Node) el.append(value);
    else el.append(document.createTextNode(String(value)));
  };
  children.forEach(append);
  return el;
};

export const div = (cls, ...children) => h('div', {class: cls}, children);
export const p = (text, cls = '') => h('p', {class: cls}, text);
export const chip = (text, tone = 'neutral') => h('span', {class: 'chip ' + tone}, h('i', {class: 'chip-dot'}), text);
export const mono = value => h('code', {class: 'mono'}, value ?? '—');
export const muted = text => h('span', {class: 'muted'}, text);
export const button = (label, fn, options = {}) => h('button', {
  type: options.submit ? 'submit' : 'button', class: 'button ' + (options.kind ?? ''), title: options.title,
  disabled: options.disabled, onclick: fn, 'aria-label': options.aria,
}, options.icon ? icon(options.icon) : null, label);
export const link = (label, route, options = {}) => h('a', {href: '#' + route, class: 'button ' + (options.kind ?? 'ghost')},
  options.icon ? icon(options.icon) : null, label, options.arrow ? icon('arrow') : null);
export const stack = (...children) => div('stack', children);

export function heading(label, title, subtitle, action) {
  return div('page-heading', div('', div('eyebrow', label), h('h1', null, title), subtitle ? p(subtitle, 'lede') : null), action);
}

export function panel(title, description, contents, action, cls = '') {
  return h('section', {class: 'panel ' + cls},
    div('panel-head', div('', h('h2', null, title), description ? p(description, 'muted small') : null), action),
    contents);
}

export function empty(title, description, glyph = 'inbox') {
  return div('empty', div('empty-icon', icon(glyph)), h('strong', null, title), description ? p(description, 'muted small') : null);
}

export function table(columns, rows, emptyText = '没有符合条件的记录') {
  if (!rows.length) return empty(emptyText);
  return div('table-scroll', h('table', null, h('thead', null,
    h('tr', null, columns.map(c => h('th', {scope: 'col'}, c)))), h('tbody', null,
    rows.map(row => h('tr', null, row.map(cell => h('td', null, cell ?? '—')))))));
}

export function tabs(options, current, route) {
  return h('nav', {class: 'tabs', 'aria-label': '视图切换'}, options.map(([id, label]) => h('a', {
    class: id === current ? 'is-current' : '', href: '#' + route(id), 'aria-current': id === current ? 'page' : null,
  }, label)));
}

export function field(label, control, help) {
  return h('label', {class: 'field'}, h('span', {class: 'field-title'}, label), control, help ? h('small', null, help) : null);
}

export function select(options, current, attrs = {}) {
  return h('select', attrs, options.map(([value, label]) => h('option', {value, selected: value === current}, label)));
}

const localTime = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
const preciseTime = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', hourCycle: 'h23',
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});

export function time(value, precise = false) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? (precise ? preciseTime : localTime).format(date) : '—';
}

export function eventState(value) {
  if (!value) return muted('—');
  const states = {
    ok: ['正常', 'green'], success: ['成功', 'green'], succeeded: ['成功', 'green'],
    sent: ['已发送', 'green'], delivered: ['已投递', 'green'], completed: ['已完成', 'green'],
    running: ['运行中', 'blue'], in_progress: ['进行中', 'blue'], active: ['活动', 'green'],
    scheduled: ['已排期', 'blue'], pending: ['待处理', 'amber'], ready: ['就绪', 'blue'],
    timeout: ['超时', 'red'], timed_out: ['超时', 'red'], error: ['异常', 'red'], failed: ['失败', 'red'],
    deny: ['已拒绝', 'red'], denied: ['已拒绝', 'red'], ERROR: ['错误', 'red'], WARN: ['警告', 'amber'],
    FATAL: ['严重', 'red'], DEBUG: ['调试', 'neutral'], INFO: ['信息', 'blue'], unknown: ['未知', 'amber'],
    cancelled: ['已取消', 'neutral'], canceled: ['已取消', 'neutral'], skipped: ['已跳过', 'neutral'],
  };
  return chip(...(Object.hasOwn(states, value) ? states[value] : [value, 'neutral']));
}

export function aligned(value) {
  return value === null || value === undefined ? chip('待核对', 'neutral') : value ? chip('与运行一致', 'green') : chip('待同步', 'amber');
}

export function banner(title, text, tone = '') {
  return div('banner ' + tone, icon(tone === 'warning' ? 'warning' : 'shield'),
    div('', h('strong', null, title), p(text, 'small')));
}

function inline(text) {
  const result = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^\s)]+)\)/gu;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    result.push(text.slice(at, match.index));
    if (match[1]) result.push(mono(match[1]));
    else if (match[2]) result.push(h('strong', null, match[2]));
    else {
      const [label, target] = match.slice(3, 5);
      const doc = /^(?:\.\/)?(\d+)_[^/]+\.md(?:#.*)?$/u.exec(target);
      const safeWeb = /^https?:\/\/[^\s]+$/u.test(target);
      result.push(doc ? h('a', {href: '#modules/doc/' + doc[1]}, label)
        : safeWeb ? h('a', {href: target, rel: 'noopener noreferrer', target: '_blank'}, label) : label);
    }
    at = match.index + match[0].length;
  }
  result.push(text.slice(at));
  return result;
}

export function markdown(text) {
  const root = div('markdown');
  const lines = text.split(/\r?\n/u);
  let list = null, code = null;
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (code) {root.append(h('pre', null, code.join('\n'))); code = null;}
      else code = [];
      list = null;
      continue;
    }
    if (code) {code.push(line); continue;}
    if (!line.trim()) {list = null; continue;}
    const entry = /^[-*]\s+(.*)$/u.exec(line);
    if (entry) {
      if (!list) {list = h('ul'); root.append(list);}
      list.append(h('li', null, inline(entry[1])));
      continue;
    }
    list = null;
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    root.append(heading ? h('h' + Math.min(5, heading[1].length + 1), null, inline(heading[2]))
      : /^(?:---+|\*\*\*+)$/u.test(line) ? h('hr')
        : line.startsWith('> ') ? h('blockquote', null, inline(line.slice(2)))
          : h('p', {class: line.startsWith('|') ? 'pipe-line' : ''}, inline(line)));
  }
  if (code) root.append(h('pre', null, code.join('\n')));
  return root;
}

export function dialog(title, description, ...content) {
  const el = document.querySelector('#dialog');
  if (el.open) el.close();
  const heading = h('h2', {id: 'dialog-title'}, title);
  el.setAttribute('aria-labelledby', heading.id);
  el.replaceChildren(div('dialog-head',
    div('', heading, description ? p(description, 'small muted') : null),
    button('', () => el.close(), {icon: 'close', kind: 'icon-only', aria: '关闭对话框'})),
    div('dialog-body', content));
  el.showModal();
  return el;
}

export function notice(message, tone = '') {
  const el = document.querySelector('#toast');
  clearTimeout(notice.timer);
  el.className = 'toast ' + tone;
  el.textContent = message;
  el.hidden = false;
  notice.timer = setTimeout(() => {el.hidden = true; el.textContent = '';}, 4500);
}
