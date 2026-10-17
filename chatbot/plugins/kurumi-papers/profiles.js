// One registry shared with the isolated Python worker. No arbitrary endpoint or credential names.
// Contract: docs/22; an explicit provider/model/channel selects its own defaults, never GPT's.
// A static JSON import is captured by OpenClaw's plugin loader; runtime fs URLs are not.
import registry from './python/profiles.json' with {type: 'json'};
const unsupported = () => Object.assign(Error('未登记或冲突的翻译组合；支持 naiccc/OpenAI gpt-6.1-sol（low/medium/high/xhigh/max），DeepSeek 官方 deepseek-flash（V4.1 Flash）、deepseek-v4-pro（none/low/high/max）。Grok 不在支持范围。'), {code: 'unsupported_translation_profile'});
export function resolveProfile(args = {}) {
  const selected = Object.fromEntries(['provider', 'channel', 'model', 'effort'].filter(key => args[key] != null).map(key => [key, String(args[key]).trim().toLowerCase()]));
  const candidates = registry.providers.filter(spec =>
    (selected.provider == null || selected.provider === spec.provider) &&
    (selected.channel == null || selected.channel === spec.channel) &&
    (selected.model == null || Object.hasOwn(spec.models, selected.model)));
  const explicit = ['provider', 'channel', 'model'].some(key => selected[key] != null);
  const spec = explicit ? (candidates.length === 1 ? candidates[0] : null) : registry.providers.find(spec => spec.provider === registry.defaultProvider);
  if (!spec) throw unsupported();
  const model = selected.model ?? spec.defaultModel, effort = selected.effort ?? spec.defaultEffort;
  if (!spec.models[model]?.includes(effort)) throw unsupported();
  return {provider: spec.provider, channel: spec.channel, model, effort, protocol: spec.protocol, baseUrl: spec.baseUrl};
}
export const DEFAULT_PROFILE = Object.freeze(resolveProfile());
export function credentialIdsForProfile(profile = {}) {
  const resolved = resolveProfile(profile);
  return [...registry.providers.find(spec => spec.provider === resolved.provider).credentialIds];
}
