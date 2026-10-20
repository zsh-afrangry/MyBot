// DeepSeek Search/Fetch providers under the host's own web_search/web_fetch. Design and status: docs/26.
// Selection stays explicit in tools.web.*.provider: no env/auth-profile credential, so the host never auto-detects it.
import path from 'node:path';
import {truncateSanitizedExternalContent, wrapWebContent} from 'openclaw/plugin-sdk/security-runtime';
import {createTraceSink} from '../../packages/observability/index.js';
import {DeepSeekWebClient, WebToolError, loadApiKey, throwIfCancelled} from './client.js';

export const PROVIDER_ID = 'deepseek';
const SEARCH_CONTENT_CHARS = 20000;
const OPERATORS = 'site:域名、-site:域名、"精确短语"、-排除词、lang:zh,en、after:YYYY-MM-DD、before:YYYY-MM-DD';
export const SEARCH_SCHEMA = {type: 'object', additionalProperties: false, required: ['query'], properties: {
  query: {type: 'string', minLength: 1, maxLength: 128, description: `搜索词，最多128字符。域名、时间、语言过滤写进query：${OPERATORS}`},
  count: {type: 'integer', minimum: 1, maximum: 10, description: '结果数，1-10，默认5'},
}};

const providerBase = (label, hint) => ({
  id: PROVIDER_ID, label, hint, requiresCredential: false, credentialLabel: 'DeepSeek凭据文件', envVars: [], placeholder: '',
  signupUrl: 'https://platform.deepseek.com/', docsUrl: 'https://api-docs.deepseek.com/guides/search/',
  credentialPath: '', inactiveSecretPaths: [], getCredentialValue: () => undefined, setCredentialValue: () => {},
});

function settings(raw = {}) {
  const credentialsFile = raw.credentialsFile, traceFile = raw.traceFile;
  if (typeof credentialsFile !== 'string' || !path.isAbsolute(credentialsFile)) throw new WebToolError('invalid_config', 'credentialsFile须为绝对路径');
  if (traceFile !== undefined && (typeof traceFile !== 'string' || !path.isAbsolute(traceFile))) throw new WebToolError('invalid_config', 'traceFile须为绝对路径');
  const timeoutSeconds = raw.timeoutSeconds ?? 25;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) throw new WebToolError('invalid_config', 'timeoutSeconds须为1-60的整数');
  return {credentialsFile, traceFile, timeoutMs: timeoutSeconds * 1000};
}

// Plugin-local cache: keys never mix with another provider, TTL follows tools.web.search.cacheTtlMinutes.
function createCache(max = 100) {
  const entries = new Map();
  return {
    get(key, ttlMs) {
      const hit = entries.get(key);
      if (!hit || Date.now() - hit.at > ttlMs) {entries.delete(key); return undefined;}
      return hit.value;
    },
    set(key, value, ttlMs) {
      if (ttlMs <= 0) return;
      entries.delete(key); entries.set(key, {at: Date.now(), value});
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
  };
}

// Light Markdown-to-text for extractMode "text"; DeepSeek Fetch only returns Markdown.
export function markdownText(value) {
  return value.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/gm, '')
    .replace(/(\*\*|__|`)(.*?)\1/g, '$2').replace(/\n{3,}/g, '\n\n').trim();
}

function rejectExtraArgs(args, allowed) {
  const extra = Object.keys(args ?? {}).filter(key => !allowed.includes(key));
  if (extra.length) throw new WebToolError('unsupported_parameter', `DeepSeek搜索不支持参数${extra.join('、')}；过滤条件请写进query：${OPERATORS}`);
}

export function createDeepSeekWebPlugin({clientFactory = options => new DeepSeekWebClient(options), traceFactory = createTraceSink} = {}) {
  return {id: 'kurumi-web-deepseek', name: 'DeepSeek web providers', register(api) {
    const config = settings(api.pluginConfig);
    const client = clientFactory({apiKey: () => loadApiKey(config.credentialsFile), timeoutMs: config.timeoutMs});
    const sink = config.traceFile ? traceFactory(config.traceFile) : null;
    const trace = data => {try {sink?.emit({source: 'web-deepseek', kind: 'provider_call', data: {provider: PROVIDER_ID, ...data}});} catch { /* Tracing never fails a tool call. */ }};
    const cache = createCache();
    // Shared wrapper: one trace line per real call, never the query text, page body or key.
    const observed = async (tool, facts, run, signal) => {
      const started = Date.now();
      try {
        const {value, summary} = await run();
        trace({tool, status: summary.resultCount === 0 ? 'empty' : 'ok', durationMs: Date.now() - started, ...facts, ...summary});
        return value;
      } catch (error) {
        const code = signal?.aborted ? 'cancelled' : error instanceof WebToolError ? error.code : 'unknown';
        trace({tool, status: code === 'cancelled' ? 'cancelled' : 'error', code, httpStatus: error?.status || undefined, durationMs: Date.now() - started, ...facts});
        throw error;
      }
    };

    api.registerWebSearchProvider({...providerBase('DeepSeek Search', '官方Search API；过滤条件写在query运算符中'),
      createTool: ctx => ({
        description: `使用DeepSeek搜索网页，返回标题、链接、摘要。过滤条件写进query：${OPERATORS}。`,
        parameters: SEARCH_SCHEMA,
        async execute(args = {}, {signal, assertCurrent} = {}) {
          throwIfCancelled(signal); assertCurrent?.();
          rejectExtraArgs(args, ['query', 'count']);
          const count = args.count ?? 5;
          if (!Number.isInteger(count) || count < 1 || count > 10) throw new WebToolError('invalid_request', 'count须为1-10的整数');
          const ttlMinutes = ctx?.searchConfig?.cacheTtlMinutes ?? ctx?.config?.tools?.web?.search?.cacheTtlMinutes ?? 15;
          const ttlMs = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60000 : 0;
          const cacheKey = JSON.stringify([args.query, count]);
          const cached = ttlMs ? cache.get(cacheKey, ttlMs) : undefined;
          if (cached) return {...cached, cached: true};
          const facts = {queryChars: typeof args.query === 'string' ? [...args.query].length : 0, count};
          return observed('web_search', facts, async () => {
            const started = Date.now();
            const {results: raw, skipped} = await client.search({query: args.query, count}, {signal, assertCurrent});
            throwIfCancelled(signal); assertCurrent?.();
            let remaining = SEARCH_CONTENT_CHARS, truncated = raw.length > count;
            const wrap = value => {
              if (!value) return '';
              const bounded = truncateSanitizedExternalContent(value, Math.max(0, remaining));
              truncated ||= bounded.truncated; remaining -= bounded.text.length;
              return bounded.text ? wrapWebContent(bounded.text, 'web_search') : '';
            };
            const results = raw.slice(0, count).map(item => ({
              title: wrap(item.title), url: item.url, snippet: wrap(item.snippet),
              ...(item.summary && item.summary !== item.snippet ? {summary: wrap(item.summary)} : {}),
              ...(item.siteName ? {siteName: item.siteName} : {}), ...(item.published ? {published: item.published} : {}),
              ...(item.score === null ? {} : {score: item.score}), authority: item.authority,
            }));
            const value = {query: args.query, provider: PROVIDER_ID, count: results.length, tookMs: Date.now() - started,
              externalContent: {untrusted: true, source: 'web_search', provider: PROVIDER_ID, wrapped: true}, results,
              ...(truncated ? {truncated: true} : {})};
            cache.set(cacheKey, value, results.length ? ttlMs : 0);
            return {value, summary: {resultCount: results.length, skipped, truncated}};
          }, signal);
        },
      }),
    });

    api.registerWebFetchProvider({...providerBase('DeepSeek Fetch', '宿主直取或正文提取失败时的补充抓取'),
      createTool: () => ({
        description: '通过DeepSeek抓取公开网页正文（Markdown）。',
        parameters: {type: 'object', additionalProperties: true, required: ['url'], properties: {url: {type: 'string'}}},
        async execute(args = {}, {signal} = {}) {
          throwIfCancelled(signal);
          return observed('web_fetch', {extractMode: args.extractMode === 'text' ? 'text' : 'markdown'}, async () => {
            const started = Date.now();
            const page = await client.fetch({url: args.url}, {signal});
            throwIfCancelled(signal);
            const text = args.extractMode === 'text' ? markdownText(page.content) : page.content;
            // The host bounds, spills and wraps text/title as untrusted; rawLength reports the provider's size.
            const value = {title: page.title, text, finalUrl: args.url, status: 200, contentType: 'text/markdown',
              extractor: 'deepseek', rawLength: page.content.length, tookMs: Date.now() - started};
            return {value, summary: {chars: page.content.length}};
          }, signal);
        },
      }),
    });
  }};
}
export default createDeepSeekWebPlugin();
