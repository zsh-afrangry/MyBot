// Render fixed layouts from published facts and verified raster assets. No remote HTML or SVG.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runSandbox} from '../../packages/sandbox/index.js';
import {imageType, MAX_IMAGE_BYTES} from '../../packages/qq-delivery/image.js';
import {heroProjection} from './query.js';
import {text} from './text.js';
import {fail} from './policy.js';

const W = 1120, X = 48, BODY = W - X * 2, GAP = 20;
const C = {background: '#0c1424', panel: '#19253a', inset: '#23334b', line: '#34445e',
  ink: '#f5f8ff', subtle: '#bac8dd', teal: '#79e7d4', gold: '#ffd28e'};
const ATTR = {fire: '火焰', ice: '寒气', wind: '自然', light: '光明', dark: '黑暗'};
const ROLE = {warrior: '战士', knight: '骑士', assassin: '盗贼', ranger: '射手', mage: '魔导士', manauser: '精灵师'};
const STATS = {hp: '生命', atk: '攻击', def: '防御', spd: '速度', chc: '暴击率', chd: '暴击伤害', eff: '效果命中', efr: '效果抗性', dac: '夹攻率'};
const HERO_STAT = {...STATS, att: '攻击', att_rate: '攻击', max_hp: '生命', max_hp_rate: '生命', def_rate: '防御',
  speed: '速度', cri: '暴击率', cri_dmg: '暴击伤害', acc: '效果命中', res: '效果抗性'};
const units = new Set(['chc', 'chd', 'eff', 'efr', 'dac']);
const rate = new Set(['att_rate', 'max_hp_rate', 'def_rate', 'cri', 'cri_dmg', 'acc', 'res', ...units]);
const fmt = new Intl.NumberFormat('en-US', {maximumFractionDigits: 3});
const num = (v, percent = false) => Number.isFinite(v) ? fmt.format(v) + (percent ? '%' : '') : '—';
const fact = (k, v) => num(rate.has(k) && Number.isFinite(v) ? v * 100 : v, rate.has(k));
const nameOf = (dict, key) => Object.hasOwn(dict, key) ? dict[key] : null;
const display = value => (typeof value === 'number' || typeof value === 'string' ? String(value) : '')
  .slice(0, 8192).toWellFormed().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069\ufffe\uffff]/gu, '');
const escape = value => value.replace(/[&<>"']/gu, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'})[c]);

function advance(char) {
  if (/\p{Mark}/u.test(char)) return 0;
  if (char === ' ') return 0.36;
  if ('MW@%'.includes(char)) return 0.94;
  return char.codePointAt(0) < 128 ? 0.68 : 1.07;
}
const measure = (value, size) => [...value].reduce((w, c) => w + advance(c) * size, 0);
function ellipsize(value, width, size, force = false) {
  const v = display(value).replace(/\s+/gu, ' ').trim();
  if (!force && measure(v, size) <= width) return v;
  let used = measure('…', size), prefix = '';
  for (const c of v) {
    used += advance(c) * size;
    if (used > width) break;
    prefix += c;
  }
  return prefix.trimEnd() + '…';
}
function wrap(value, size, width, max) {
  const lines = [];
  for (const block of display(value).split(/\r?\n/u)) {
    if (!block.trim()) continue;
    if (lines.length === max) {
      lines[max - 1] = ellipsize(lines[max - 1], width, size, true);
      return lines;
    }
    let line = '', used = 0;
    for (const c of block.trim().replace(/\s+/gu, ' ')) {
      const step = advance(c) * size;
      if (used + step > width && line) {
        lines.push(line.trimEnd());
        if (lines.length === max) {
          lines[max - 1] = ellipsize(lines[max - 1], width, size, true);
          return lines;
        }
        line = ''; used = 0;
      }
      if (!line && c === ' ') continue;
      used += step; line += c;
    }
    if (line) lines.push(line);
  }
  return lines;
}

class Card {
  nodes = [];
  layers = [];
  rect(x, y, w, h, fill = C.panel, r = 16) {
    this.nodes.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`);
  }
  label(value, x, y, {size = 24, fill = C.ink, bold = false, width = BODY, right = false} = {}) {
    this.nodes.push(`<text x="${x}" y="${y}" fill="${fill}" font-size="${size}"${bold ? ' font-weight="700"' : ''}${right ? ' text-anchor="end"' : ''}>${escape(ellipsize(value, width, size))}</text>`);
  }
  lines(lines, x, y, size, step, fill = C.ink) {
    for (const line of lines) {this.label(line, x, y, {size, fill}); y += step;}
    return y;
  }
  image(asset, x, y, width, height) {
    if (asset) this.layers.push({asset, left: x, top: y, width, height});
  }
  layout(height) {
    return {height, layers: this.layers, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}">
      <rect width="100%" height="100%" fill="${C.background}"/>
      <g font-family="Noto Sans CJK SC, sans-serif">${this.nodes.join('')}</g></svg>`};
  }
}

function statGrid(card, stats, names, x, y, width, columns) {
  const w = Math.floor((width - (columns - 1) * 9) / columns);
  names.forEach((key, i) => {
    const left = x + i % columns * (w + 9), top = y + Math.floor(i / columns) * 66;
    card.rect(left, top, w, 58, C.inset, 8);
    card.label(STATS[key], left + 9, top + 20, {size: 15, fill: C.subtle, width: w - 18});
    const value = num(stats[key], units.has(key));
    const size = Math.max(13, Math.min(23, Math.floor((w - 18) / measure(value, 1))));
    card.label(value, left + 9, top + 46, {size, bold: true, width: w - 18});
  });
  return y + Math.ceil(names.length / columns) * 66;
}
function footer(card, y, source) {
  card.rect(X, y, BODY, 2, C.line, 0);
  card.label(source, X, y + 31, {size: 20, fill: C.teal});
  card.label('Kurumi 制图 · 游戏素材版权归《第七史诗》权利方', X, y + 58, {size: 18, fill: C.subtle});
  return card.layout(y + 88);
}

export function heroCardLayout(hero, {portrait, icons = new Map(), source}) {
  const card = new Card();
  const {stats, percentages} = heroProjection(hero, {view: 'stats'}).data;
  card.label('KURUMI  /  第七史诗角色图鉴', X, 58, {size: 21, bold: true, fill: C.teal});
  card.label(hero.name, X, 125, {size: 54, bold: true, width: 650});
  card.label([hero.nameEn, nameOf(ATTR, hero.attribute), nameOf(ROLE, hero.role),
    Number.isInteger(hero.rarity) ? hero.rarity + ' 星' : null].filter(Boolean).join('  /  '), X, 164, {size: 23, fill: C.subtle, width: 660});
  card.label(text(hero.subtitle), X, 198, {size: 20, fill: C.subtle, width: 660});
  card.rect(X, 225, 655, 220);
  card.label('基础面板', X + 18, 258, {size: 23, bold: true});
  card.label('不含装备 · 等级/觉醒口径未注明', X + 152, 258, {size: 16, fill: C.subtle, width: 468});
  statGrid(card, {...stats, ...percentages}, ['atk', 'def', 'hp', 'spd', 'chc', 'chd', 'eff', 'efr', 'dac'], X + 18, 275, 619, 5);
  card.rect(726, 80, 346, 365, C.panel, 24);
  if (portrait) card.image(portrait, 731, 85, 336, 355);
  else card.label('角色图片暂不可用', 784, 264, {fill: C.subtle, size: 23});

  let y = 479;
  const imprint = (label, d) => {
    const k = d?.type, val = d?.grades?.sss;
    return typeof k === 'string' && Number.isFinite(val) ? label + ' SSS：' + (nameOf(HERO_STAT, k) ?? k) + ' ' + fact(k, val) : null;
  };
  const imprints = [imprint('阵型刻印', hero.devotion), imprint('自身刻印', hero.selfDevotion)].filter(Boolean);
  if (imprints.length) {
    card.label(imprints.join('　｜　'), X, y, {size: 22, fill: C.gold});
    y += 37;
  }
  const ee = hero.exclusiveEquipment;
  if (ee && text(ee.name)) {
    const p = ee.mainStat;
    const eeStat = typeof p?.type === 'string' && Number.isFinite(p.min) && Number.isFinite(p.max)
      ? '　｜　' + (nameOf(HERO_STAT, p.type) ?? p.type) + ' ' + fact(p.type, p.min) + '–' + fact(p.type, p.max) : '';
    card.label('专属装备：' + text(ee.name) + eeStat, X, y, {size: 22, fill: C.gold});
    y += 37;
  }
  const credits = [hero.voice?.zhs, hero.voice?.ja].map(v => text(v)).filter(Boolean);
  if (credits.length) {card.label(credits.join('  /  '), X, y, {size: 21, fill: C.subtle}); y += 35;}
  y += 18;
  card.label('技能与倍率', X, y, {size: 29, bold: true});
  y += 22;
  for (const s of [1, 2, 3].map(slot => hero.skills.find(r => r.slot === slot)).filter(Boolean)) {
    const d = wrap(text(s.description) || '来源未列技能说明', 24, BODY - 44, 7);
    const bonus = [s.soulBurn && text(s.soulBurn.description) ? ['灵魂燃烧' + (Number.isFinite(s.soulBurn.cost) ? ' ' + s.soulBurn.cost : ''), text(s.soulBurn.description)].join('：') : '',
      ...(Array.isArray(ee?.skills) ? ee.skills.filter(a => a?.slot === s.slot).slice(0, 3).map(a => '专属效果：' + text(a.description)) : [])].filter(Boolean);
    const extras = wrap(bonus.join('\n'), 21, BODY - 44, 5);
    const multiplier = (s.multipliers ?? []).slice(0, 6).map(group => {
      const values = (Array.isArray(group?.items) ? group.items : []).slice(0, 6).map(row => {
        const k = row?.key === 'att_rate' ? '基础倍率' : row?.key === 'pow' ? '修正倍率' : text(row?.label || row?.key);
        const v = text(row?.value);
        return k && v ? k + ' ' + v : '';
      }).filter(Boolean);
      const label = text(group?.label);
      return values.length ? (label && label !== '技能倍率' ? label + '：' : '') + values.join('　·　') : '';
    }).filter(Boolean);
    const m = wrap(multiplier.length ? multiplier.join('\n') : '来源未列倍率', 22, BODY - 44, 4);
    const h = 97 + 34 * d.length + 29 * extras.length + 30 * m.length;
    card.rect(X, y, BODY, h);
    const icon = icons.get(s.slot);
    if (icon) card.image(icon, X + 20, y + 17, 52, 52);
    else card.rect(X + 20, y + 17, 52, 52, C.inset, 12);
    card.label('S' + s.slot + '  ' + text(s.name), X + 88, y + 53, {size: 29, bold: true, width: 510});
    const timing = [text(s.cooldown), Number.isFinite(s.soulGain) ? '获得 ' + s.soulGain + ' 点灵魂' : null].filter(Boolean).join('  ·  ');
    card.label(timing, W - X - 20, y + 50, {size: 19, fill: C.subtle, width: 400, right: true});
    let body = card.lines(d, X + 22, y + 94, 24, 34);
    body = card.lines(extras, X + 22, body, 21, 29, C.subtle);
    card.lines(m, X + 22, body, 22, 30, C.teal);
    y += h + 16;
  }
  return footer(card, y + 5, source);
}

export function buildCardLayout(hero, {samples, requested, total, avatar, source}) {
  const card = new Card();
  card.label('KURUMI  /  社区配装', X, 58, {size: 21, bold: true, fill: C.teal});
  if (avatar) {
    card.rect(X, 82, 92, 92, C.panel, 18);
    card.image(avatar, X + 4, 86, 84, 84);
  }
  const titleX = avatar ? X + 112 : X;
  card.label(hero.name, titleX, 129, {size: 45, bold: true, width: 780});
  card.label(`请求 ${requested} 条  ·  展示 ${samples.length} 条  ·  符合条件 ${total} 条`,
    titleX, 166, {size: 21, fill: C.subtle, width: 780});
  card.label('面板含装备 · 按来源顺序 · 社区样本，不代表全服统计或最优配装',
    X, 215, {size: 21, fill: C.gold});

  const cols = samples.length === 1 ? 1 : 2, tileW = (BODY - (cols - 1) * GAP) / cols;
  const tileH = 326, top = 242;
  for (const [i, row] of samples.entries()) {
    const x = X + (i % cols) * (tileW + GAP), y = top + Math.floor(i / cols) * (tileH + GAP);
    card.rect(x, y, tileW, tileH);
    card.label(String(i + 1).padStart(2, '0'), x + 18, y + 38, {size: 21, fill: C.teal, bold: true, width: 40});
    card.label(row.name, x + 64, y + 39, {size: 26, bold: true, width: tileW - 83});
    const arm = row.artifact?.name || row.artifact?.code || '未注明';
    card.label('套装：' + (row.sets.join(' + ') || '未注明'), x + 18, y + 76, {size: 20, width: tileW - 36});
    card.label('神器：' + arm, x + 18, y + 105, {size: 20, fill: C.gold, width: tileW - 36});
    statGrid(card, row.stats, ['hp', 'atk', 'def', 'spd', 'chc', 'chd', 'eff', 'efr'], x + 18, y + 124, tileW - 36, 4);
    card.label('作者：' + (row.author || '未注明'), x + 18, y + 279, {size: 19, fill: C.subtle, width: tileW - 36});
    card.label('来源更新时间：' + (row.updatedAt || '未注明'), x + 18, y + 305, {size: 19, fill: C.subtle, width: tileW - 36});
  }
  return footer(card, top + Math.ceil(samples.length / cols) * (tileH + GAP) + 8, source);
}

export async function renderCard(layout, {signal} = {}) {
  signal?.throwIfAborted();
  const {svg, height, layers} = layout;
  if (!Number.isSafeInteger(height) || height < 1 || height > 3800 || layers.length > 4) fail('image_render_failed');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kurumi-e7-card-'));
  try {
    const manifest = [];
    const put = (name, bytes) => fs.writeFile(path.join(workspace, name), bytes, {flag: 'wx', mode: 0o600});
    for (const [i, {asset, ...box}] of layers.entries()) {
      const filename = 'asset-' + i;
      await put(filename, asset.bytes);
      manifest.push({filename, ...box});
    }
    await put('card.svg', svg);
    await put('card.json', JSON.stringify({width: W, height, layers: manifest}));
    const raster = fileURLToPath(new URL('./card-raster.py', import.meta.url));
    const run = await runSandbox({root: workspace, fixtures: [{source: raster, target: '/checks/card-raster.py'}]}, [
      '/usr/bin/prlimit', '--as=1073741824', '--cpu=8', '--fsize=' + MAX_IMAGE_BYTES, '--',
      '/usr/bin/python3', '-I', '/checks/card-raster.py',
    ], {signal, timeoutMs: 12000});
    signal?.throwIfAborted();
    if (run.code !== 0) fail('image_render_failed');
    const file = await fs.open(path.join(workspace, 'card.png'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 24 || stat.size > MAX_IMAGE_BYTES) fail('image_render_failed');
      const bytes = await file.readFile();
      if (imageType(bytes) !== 'image/png' || bytes.readUInt32BE(16) !== W || bytes.readUInt32BE(20) !== height) fail('image_render_failed');
      return {bytes, contentType: 'image/png'};
    } finally {await file.close();}
  } catch {
    signal?.throwIfAborted();
    fail('image_render_failed');
  } finally {await fs.rm(workspace, {recursive: true, force: true});}
}
