import {h, div, p, icon, button, empty, notice} from './components.js';
import * as pages from './pages.js';

const navigation = [
  ['工作台', [['overview', '总览', 'home'], ['modules', '项目地图', 'layers']]],
  ['角色与数据', [['persona', '人格与关系', 'soul'], ['memory', '记忆', 'memory'], ['access', '身份与白名单', 'shield']]],
  ['运行维护', [['tasks', '任务与调度', 'task'], ['logs', '链路日志', 'logs'], ['git', 'Git 工作树与分支', 'git'], ['system', '运行配置', 'system']]],
];
const app = document.querySelector('#app');
const sessionKey = 'kurumi-admin-session';
let isAuthenticated = false, version, navigationState;
let token;
try {token = sessionStorage.getItem(sessionKey);} catch {}

function setToken(value) {
  token = value;
  try {
    if (value) sessionStorage.setItem(sessionKey, value);
    else sessionStorage.removeItem(sessionKey);
  } catch {}
}

function openRoute() {
  const [pathname, search = ''] = location.hash.slice(1).split('?');
  const [key, ...part] = (pathname || 'overview').split('/');
  const item = navigation.flatMap(([, items]) => items).find(([id]) => id === key) ?? navigation[0][1][0];
  return {key: item[0], label: item[1], part: part.join('/'), params: new URLSearchParams(search)};
}

async function api(endpoint, data, signal, sessionCheck = true) {
  const response = await fetch('/api' + endpoint, {
    ...(data === undefined ? {} : {method: 'POST', body: JSON.stringify(data)}),
    headers: {...(data === undefined ? {} : {'Content-Type': 'application/json'}),
      ...(token ? {Authorization: 'Bearer ' + token} : {})},
    mode: 'same-origin', credentials: 'omit', cache: 'no-store', signal,
  });
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401 && sessionCheck && isAuthenticated) {
      isAuthenticated = false;
      setToken(null);
      connectView();
      notice('登录已失效，请重新登录。', 'warning');
    }
    throw Error(payload.error ?? '请求未完成。');
  }
  return payload;
}

function brand() {
  return div('brand', h('img', {src: '/mark.svg', width: '40', height: '40', alt: ''}),
    div('', h('strong', null, 'Kurumi'), h('small', null, 'FUSION 工作台')));
}

function connectView() {
  navigationState?.abort();
  const modal = document.querySelector('#dialog');
  if (modal.open) modal.close();
  const input = h('input', {type: 'password', required: true, autocomplete: 'current-password',
    placeholder: '本机管理台访问密钥', maxlength: '64', id: 'access-key'});
  const msg = p('', 'form-error');
  msg.hidden = true; msg.setAttribute('role', 'alert');
  const submit = button('登录管理台', undefined, {submit: true, kind: 'primary', icon: 'arrow'});
  app.replaceChildren(h('main', {class: 'login-layout'}, div('login-cover',
    div('login-cover-inner', brand(), div('login-crest', h('img', {src: '/mark.svg', alt: '', width: '116', height: '116'})),
      div('', div('eyebrow', 'PERSONAL OPERATING SPACE'),
        h('h1', null, '照看 Kurumi 的世界。'), p('角色陪伴 · 工作助手 · Fusion 运维')),
      div('login-line'))), div('login-content',
    div('login-form-wrap', div('eyebrow', 'OWNER CONSOLE'), h('h2', null, '进入管理台'),
      p('用本机访问密钥登录。', 'muted'),
      h('form', {class: 'form-stack', onsubmit: async event => {
        event.preventDefault(); msg.hidden = true; submit.disabled = true;
        try {
          const result = await api('/login', {key: input.value.trim()}, undefined, false);
          setToken(result.token);
          isAuthenticated = true; version = result.version; input.value = ''; render();
        } catch (error) {msg.textContent = error.message; msg.hidden = false;}
        finally {submit.disabled = false;}
      }}, h('label', {class: 'field'}, h('span', {class: 'field-title'}, '访问密钥'), input), msg, submit),
      h('details', {class: 'login-help'}, h('summary', null, icon('key'), '如何获取密钥'),
        p('在启动管理台的本机账号终端执行：'), h('pre', {class: 'command'}, 'cat ~/.local/state/kurumi-admin-web/access-key'),
        p('密钥仅供本机浏览器使用。', 'muted small'))))));
}

function shell(route) {
  const layout = div('layout');
  const toggle = button('', () => {
    const opened = layout.classList.toggle('menu-open');
    toggle.setAttribute('aria-expanded', String(opened));
  }, {kind: 'icon-only mobile-menu', icon: 'menu', aria: '打开导航'});
  toggle.setAttribute('aria-expanded', 'false');
  const logout = button('退出', async () => {
    try {await api('/logout', {}); isAuthenticated = false; setToken(null); connectView();}
    catch (error) {notice(error.message, 'warning');}
  }, {kind: 'ghost logout', icon: 'logout'});
  const aside = h('aside', {class: 'sidebar'},
    h('a', {class: 'brand-link', href: '#overview'}, brand()),
    h('nav', {'aria-label': '主导航'}, navigation.map(([group, items]) =>
      div('nav-group', div('nav-label', group), items.map(([id, label, glyph]) => h('a', {
        href: '#' + id, class: 'nav-item' + (id === route.key ? ' is-current' : ''),
        'aria-current': id === route.key ? 'page' : null,
      }, icon(glyph), h('span', null, label), id === route.key ? icon('chevron', 'nav-chev') : null))))),
    div('sidebar-foot', div('side-lock', icon('shield')), div('', h('strong', null, '主人管理台'),
      h('small', null, version ? '本机访问 · v' + version : '本机访问'))));
  const main = h('main', {id: 'main', class: 'main', 'aria-busy': 'true'});
  layout.append(aside,
    button('', () => {layout.classList.remove('menu-open'); toggle.setAttribute('aria-expanded', 'false');},
      {kind: 'menu-backdrop', aria: '关闭导航'}),
    div('frame', h('header', {class: 'topbar'},
      div('crumb', toggle, h('span', {class: 'crumb-root'}, 'Fusion 管理'), icon('chevron'), h('strong', null, route.label)),
      div('top-actions', h('span', {class: 'local-tag'}, h('i'), '本机'),
        button('', render, {kind: 'icon-only', icon: 'refresh', title: '刷新页面数据', aria: '刷新页面数据'}), logout)), main));
  return {layout, main};
}

function go(route) {
  if (location.hash === '#' + route) render();
  else location.hash = route;
}

async function render() {
  if (!isAuthenticated) return;
  navigationState?.abort();
  const state = new AbortController();
  navigationState = state;
  const modal = document.querySelector('#dialog');
  if (modal.open) modal.close();
  const route = openRoute();
  document.title = route.label + ' · Kurumi Fusion';
  const {layout, main} = shell(route);
  app.replaceChildren(layout);
  const timer = setTimeout(() => {
    if (!state.signal.aborted) main.append(div('loading', h('i'), '正在读取 ' + route.label + '…'));
  }, 180);
  try {
    const page = await pages[route.key]({...route, go, reload: render, api: (url, data) => api(url, data, state.signal)});
    if (!state.signal.aborted) main.replaceChildren(page);
  } catch (error) {
    if (!state.signal.aborted) main.replaceChildren(div('failed-page', empty('读取失败', error.message, 'warning'),
      button('重试', render, {kind: 'primary', icon: 'refresh'})));
  } finally {
    clearTimeout(timer);
    main.removeAttribute('aria-busy');
  }
}

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});
try {
  const session = await api('/session');
  version = session.version;
  isAuthenticated = session.authenticated;
  if (isAuthenticated) render();
  else {setToken(null); connectView();}
} catch {
  app.replaceChildren(div('failed-page', empty('管理台连接失败', '请检查本机服务后刷新页面。', 'warning'),
    button('重新连接', () => location.reload(), {kind: 'primary', icon: 'refresh'})));
}
