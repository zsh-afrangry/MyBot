// Only assets explicitly referenced by the selected hero's published record.
import {codePattern, fail, object} from './policy.js';

const PREFIX = Object.freeze({avatar: 'avatar', detail: 'detailImage', cover: 'cover', skill: 'skills', effect: 'effects'});
export const IMAGE_KINDS = Object.freeze(Object.keys(PREFIX));
const TTL_MS = 7 * 86400000;
const CACHE_BYTES = 50 * 1024 * 1024;

export function validateImageQuery(args) {
  if (!object(args) || Object.keys(args).some(k => !['heroCode', 'kind', 'skill', 'effectId'].includes(k))
    || typeof args.heroCode !== 'string' || !codePattern.test(args.heroCode) || !IMAGE_KINDS.includes(args.kind)
    || (args.kind === 'skill' ? ![1, 2, 3].includes(args.skill) : 'skill' in args)
    || (args.kind === 'effect' ? typeof args.effectId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(args.effectId) : 'effectId' in args))
    fail('invalid_query');
  return args;
}

export function acceptedImagePath(kind, relative) {
  return IMAGE_KINDS.includes(kind) && typeof relative === 'string' && relative.length <= 512 && !relative.includes('..')
    && relative.startsWith('/static/' + PREFIX[kind] + '/')
    && /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp)$/iu.test(relative);
}

export function selectImage(hero, args) {
  let path;
  if (args.kind === 'skill') path = hero.skills.find(s => s.slot === args.skill)?.iconUrl;
  else if (args.kind === 'effect') {
    const icons = new Set(hero.skills.flatMap(s => (s.effects ?? []).filter(e => String(e?.id) === args.effectId).map(e => e.iconUrl))
      .filter(p => acceptedImagePath('effect', p)));
    if (icons.size === 1) [path] = icons;
  } else path = hero[{avatar: 'avatarUrl', detail: 'detailImageUrl', cover: 'coverUrl'}[args.kind]];
  if (!acceptedImagePath(args.kind, path)) fail('image_unavailable');
  return path;
}

export class E7ImageCache {
  #entries = new Map();
  #size = 0;
  #drop(key, entry) {
    this.#entries.delete(key);
    this.#size -= entry.asset.bytes.length;
  }
  get(key, now) {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (now - entry.fetchedAt >= TTL_MS) {this.#drop(key, entry); return null;}
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.asset;
  }
  set(key, asset, now) {
    for (const [id, entry] of this.#entries) if (id === key || now - entry.fetchedAt >= TTL_MS) this.#drop(id, entry);
    while (this.#entries.size && this.#size + asset.bytes.length > CACHE_BYTES) this.#drop(...this.#entries.entries().next().value);
    this.#entries.set(key, {asset, fetchedAt: now});
    this.#size += asset.bytes.length;
  }
  clear() {this.#entries.clear(); this.#size = 0;}
}
