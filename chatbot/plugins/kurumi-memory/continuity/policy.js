// Language understanding stays in the model; policy checks evidence and bounded structures.
import {normalize} from '../model.js';
import {safeText} from './model.js';
// reach[i] bit 1: prefix of length i is covered; bit 2: covered with at least one evidence piece.
function composed(target, old, current) {
  const reach = new Uint8Array(target.length + 1); reach[0] = 1;
  for (let i = 0; i < target.length; i++) if (reach[i]) for (let j = i + 2; j <= target.length; j++) {
    const piece = target.slice(i, j), fromCurrent = current.includes(piece);
    // A longer piece from the same start contains this one, so it cannot match either.
    if (!fromCurrent && !old.includes(piece)) break;
    reach[j] |= (fromCurrent || (reach[i] & 2)) ? 3 : 1;
  }
  return Boolean(reach[target.length] & 2);
}
export const continuityPolicy = Object.freeze({
  evidence(text, request) {
    const value = safeText(text);
    if (!normalize(request.raw).includes(normalize(value))) throw Error('来源必须逐字取自本次本人QQ原文，不能用引用、网页或旧上下文');
    return value;
  },
  // `previous` is only passed for an id-targeted correction. Then the new text may be
  // stitched from old-record and current-evidence pieces (each >= 2 chars, at least one
  // from the evidence), so "不对，是小黑" can turn "我养的猫叫小白" into "我养的猫叫小黑"
  // without inventing words neither side contains.
  fact(text, evidence, previous) {
    const value = safeText(text), target = normalize(value), current = normalize(evidence);
    if (current.includes(target)) return value;
    if (previous === undefined || !composed(target, normalize(previous), current)) {
      throw Error(previous === undefined ? '长期事实必须保留当前来源中的原话，不将推断改写为事实'
        : '更正内容只能由旧记录和本次原话的片段（每段至少2字，至少一段来自本次原话）拼成，不加入两者都没有的内容');
    }
    return value;
  },
  summary(text) {return safeText(text, 600);},
});
