// Language understanding stays in the model; policy checks evidence and bounded structures.
import {normalize} from '../model.js';
import {safeText} from './model.js';
export const continuityPolicy = Object.freeze({
  evidence(text, request) {
    const value = safeText(text);
    if (!normalize(request.raw).includes(normalize(value))) throw Error('来源必须逐字取自本次本人QQ原文，不能用引用、网页或旧上下文');
    return value;
  },
  fact(text, evidence) {
    const value = safeText(text);
    if (!normalize(evidence).includes(normalize(value))) throw Error('长期事实必须保留当前来源中的原话，不将推断改写为事实');
    return value;
  },
  summary(text) {return safeText(text, 600);},
});
