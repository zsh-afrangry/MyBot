// Fact format and normalization, independent of user wording and storage.
export const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

export function validateFact(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 300 || /[\r\n\0]/u.test(text)) throw Error('记忆必须是1至300字的单条事实');
  if (/密码|口令|私钥|api[ _-]?key|access[ _-]?token|bearer\s|sk-[a-z0-9]|-----BEGIN/iu.test(text)) throw Error('不将凭证保存为长期记忆');
  return text.trim();
}
