// Explicit translation profiles. Unregistered providers/models fail; no silent substitution.
export const DEFAULT_PROFILE = Object.freeze({provider: 'openai', channel: 'naiccc', model: 'gpt-6.1-sol', effort: 'max', protocol: 'responses', baseUrl: 'https://naiccc.com/v1'});
export function resolveProfile(args = {}) {
  const selected = {...DEFAULT_PROFILE};
  for (const key of ['provider', 'channel', 'model', 'effort']) {
    if (args[key] != null) selected[key] = String(args[key]).trim().toLowerCase();
  }
  if (selected.provider !== 'openai' || selected.channel !== 'naiccc' || selected.model !== 'gpt-6.1-sol' || !['low','medium','high','xhigh','max'].includes(selected.effort)) {
    const error = Error('未登记的翻译组合；当前支持 naiccc / OpenAI / gpt-6.1-sol，强度 low/medium/high/xhigh/max。DeepSeek、Grok 接入待单独验证。');
    error.code = 'unsupported_translation_profile'; throw error;
  }
  return selected;
}
