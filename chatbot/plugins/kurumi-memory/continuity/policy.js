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
  deletion(evidence, request) {
    const value = this.evidence(evidence, request);
    // A conservative rejection boundary, not a natural-language authorization classifier.
    // Check the entire trusted request so selecting a small affirmative fragment cannot
    // remove the question/quotation/negation around it.
    const raw = normalize(request.raw);
    if (/[?？]|(?:吗|么|呢)[。！!\s]*$|是否|有没有|了没有|还记得|还记着|忘了没|删了没|为什么|怎么|如何|如果|假如|假设|他说|她说|引用|转述|^[“「『"]|(?:不要|不用|别|不必|先不|暂不).{0,8}(?:忘|删|移除|清除|清空)/u.test(raw)) {
      throw Error('当前消息是疑问、引用、条件或否定，不能补做旧遗忘请求；本次未提交，请澄清后等待新的明确要求');
    }
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
