// Cache/read/query orchestration, shared in-flight reads and an explicitly stopped daily refresher.
import {E7Client, endpoint} from './client.js';
import {E7Store, digest} from './store.js';
import {E7Error, fail, settings, ttlFor, CATALOGS, normalize, nextRefresh, object} from './policy.js';
import {validateQuery, validateData, dataCount, text, matchRows, cardProjection, artifactIdentity, heroProjection, artifactProjection, dictionaryProjection, pageRows, boundResult} from './query.js';
import {buildProjection, reviewProjection, matchBuilds} from './query.js';
import {rankingIdentity, rankingTiers, rankingEntries, contentProjection, contentCursor, contentPage, faqFallbackQueries} from './reference.js';

const contentKey = (kind, contentId) => JSON.stringify(['contentLocator', {kind, contentId}]);

function waitFor(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new E7Error('cancelled'));
    signal.addEventListener('abort', abort, {once: true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class E7Service {
  constructor(config, {client, store, clock = Date.now, timers = {set: setTimeout, clear: clearTimeout}, onRefresh = () => {}} = {}) {
    this.config = settings(config); this.client = client ?? new E7Client(this.config); this.store = store ?? new E7Store(this.config.cacheRoot);
    this.clock = clock; this.timers = timers; this.onRefresh = onRefresh;
    this.flights = new Map(); this.controller = new AbortController(); this.closed = false; this.started = false;
  }
  start() {
    if (this.started) return;
    this.started = true; this.closed = false;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.schedule();
  }
  schedule() {
    if (!this.started || this.closed || !this.config.refreshEnabled) return;
    this.timer = this.timers.set(async () => {
      this.timer = undefined;
      try {await this.refresh();} catch {} finally {this.schedule();}
    }, Math.max(1, nextRefresh(this.clock(), this.config.refreshTime) - this.clock()));
    this.timer?.unref?.();
  }
  async stop() {
    this.closed = true; this.started = false;
    if (this.timer !== undefined) this.timers.clear(this.timer); this.timer = undefined;
    this.controller.abort(); await Promise.allSettled([...this.flights.values()]);
  }
  async refresh() {
    const results = [];
    for (const kind of CATALOGS) {
      if (this.closed) break;
      const result = await this.resource(kind, {}, {force: true});
      results.push({kind, stale: result.stale, warning: result.warning ?? null});
      if (result.warning) break; // A refused/limited host is never retried by the daily loop.
    }
    this.onRefresh(results); return results;
  }
  async resource(kind, params = {}, {signal, force = false} = {}) {
    if (this.closed) fail('service_stopped');
    signal?.throwIfAborted();
    const key = JSON.stringify([kind, params]);
    if (!this.flights.has(key)) {
      const task = this.load(kind, params, key, force);
      this.flights.set(key, task);
      task.finally(() => {if (this.flights.get(key) === task) this.flights.delete(key);}).catch(() => {});
    }
    return waitFor(this.flights.get(key), signal);
  }
  async load(kind, params, key, force) {
    let old = this.store.read(key);
    if (old) {try {validateData(kind, old.data, params);} catch {old = null;}}
    const result = (record, stale = false, warning) => ({...record, stale, ...(warning ? {warning} : {})});
    if (old && !force && this.clock() - old.checkedAt < ttlFor(kind, this.config)) return result(old);
    try {
      const response = await this.client.read(kind, params, {signal: this.controller.signal, validators: old ?? {}});
      let record;
      if (response.status === 304) {
        if (!old) fail('unexpected_not_modified');
        record = {...old, checkedAt: this.clock()};
      } else {
        const data = validateData(kind, response.data, params), count = dataCount(kind, data);
        if (old && CATALOGS.includes(kind) && count < dataCount(kind, old.data) * 0.9) fail('catalog_shrank');
        const hash = digest(data);
        record = {data, hash, fetchedAt: old?.hash === hash ? old.fetchedAt : this.clock(), checkedAt: this.clock(), url: endpoint(kind, params).url,
          etag: response.etag, lastModified: response.lastModified};
      }
      this.controller.signal.throwIfAborted(); this.store.write(key, record); return result(record);
    } catch (error) {
      if (this.controller.signal.aborted) throw new E7Error('cancelled');
      if (old) return result(old, true, error instanceof E7Error ? error.code : 'upstream_failed');
      throw error instanceof E7Error ? error : new E7Error('upstream_failed');
    }
  }
  async query(raw, {signal} = {}) {
    const args = validateQuery(raw), resources = [];
    const get = async (kind, params = {}) => {
      const r = await this.resource(kind, params, {signal}); resources.push(r); return r;
    };
    const rememberContent = (kind, params, record) => {
      signal?.throwIfAborted();
      for (const row of record.data.list) this.store.write(contentKey(kind, String(row.id)), {...record, data: params, hash: digest(params)});
    };
    let data, missingFields = [], status = 'ok';
    if (args.action === 'search') {
      const base = await get(args.kind === 'hero' ? 'cards' : 'artifacts');
      let rows = base.data;
      if (args.filters?.effectIds) {
        const effects = await get('effects'), summary = await get('summary');
        const selected = args.filters.effectIds.map(id => effects.data.find(e => String(e.id) === id));
        if (selected.some(e => !e)) fail('unknown_effect');
        const wanted = selected.map(e => normalize(e.name));
        const codes = new Set(summary.data.filter(row => {
          const names = [row.buff_names, row.debuff_names, row.commonbuff_names].filter(Boolean).flatMap(s => String(s).split(/[,，]/)).map(normalize);
          return wanted.every(n => names.includes(n));
        }).map(r => r.hero_code));
        rows = rows.filter(r => codes.has(r.code));
      }
      const found = matchRows(rows, args.query, args.filters);
      data = {...pageRows(found.rows.map(args.kind === 'hero' ? cardProjection : artifactIdentity), args, resources.map(r => r.hash)),
        match: found.match, needsSelection: Boolean(args.query && found.rows.length > 1), scope: '完整本地角色/神器索引'};
    }
    if (args.action === 'hero') {
      const cards = await get('cards');
      if (!cards.data.some(r => r.code === args.heroCode)) {status = 'not_found'; data = null;}
      else {
        const detail = await get('hero', {heroCode: args.heroCode});
        ({data, missingFields} = heroProjection(detail.data, args));
      }
    }
    if (args.action === 'artifact') {
      const all = await get('artifacts'), row = all.data.find(a => String(a.id) === args.artifactId);
      data = row ? artifactProjection(row, args.view) : null;
      if (!row) status = 'not_found'; else if (args.view === 'effect' && !row.skill_display_desc) missingFields.push('effect');
    }
    if (['builds', 'reviews'].includes(args.action)) {
      const cards = await get('cards'), hero = cards.data.find(r => r.code === args.heroCode);
      if (!hero) {status = 'not_found'; data = null;}
      else {
        const all = await get(args.action, {heroCode: args.heroCode});
        const rows = args.action === 'builds' ? matchBuilds(all.data.map(buildProjection), args.filters)
          : all.data.filter(r => !args.category || r.category === args.category).map(reviewProjection);
        data = {...cardProjection(hero), ...pageRows(rows, args, all.hash),
          coverage: '来源返回的该角色完整列表，筛选与续页在本地完成',
          ...(args.action === 'reviews' ? {availableCategories: [...new Set(all.data.map(r => text(r.category)))]} : {})};
        if (args.action === 'builds' && data.items.some(r => Object.values(r.stats).some(v => v === null))) missingFields.push('items.stats');
        if (args.action === 'reviews' && data.items.some(r => !r.content)) missingFields.push('items.content');
      }
    }
    if (args.action === 'rankings') {
      const all = await get('rankings');
      const rows = all.data.filter(r => !args.objectType || r.type === args.objectType);
      if (args.mode === 'list') {
        data = {...pageRows(rows.map(rankingIdentity), args, all.hash), untypedCount: all.data.filter(r => !['hero', 'artifact'].includes(r.type)).length,
          coverage: '来源完整榜单列表；类型筛选只包含来源明确标注的对象类型'};
        if (data.items.some(r => r.objectType === null)) missingFields.push('items.objectType');
      } else {
        const row = rows.find(r => String(r.id) === args.rankingId);
        if (!row) {status = 'not_found'; data = null;}
        else {
          data = {...rankingIdentity(row), tiers: rankingTiers(row), ...pageRows(rankingEntries(row), args, all.hash),
            coverage: '同一榜单的分档条目；objectCode遵循来源类型，类型未知时不当成角色或神器'};
          if (data.objectType === null) missingFields.push('objectType');
        }
      }
    }
    if (args.action === 'content') {
      const kind = args.kind === 'guide' ? 'guides' : 'faq';
      let params, cursor;
      if (args.mode === 'search') {
        cursor = contentCursor(args);
        params = {page: cursor.p, ...((cursor.q ?? args.query) ? {query: cursor.q ?? args.query} : {})};
      } else {
        const locator = this.store.read(contentKey(args.kind, args.contentId));
        params = locator?.data;
        if (!object(params) || Object.keys(params).some(k => !['page', 'query'].includes(k))
          || !Number.isInteger(params.page) || params.page < 1 || params.page > 1000) fail('content_search_required');
        try {validateQuery({action: 'content', kind: args.kind, mode: 'search', ...('query' in params ? {query: params.query} : {})});}
        catch {fail('content_search_required');}
      }
      let all = await get(kind, params);
      const attemptedQueries = args.mode === 'search' ? [params.query ?? null] : [];
      if (args.mode === 'search' && args.kind === 'faq' && args.query && !args.cursor && all.data.pagination.total === 0 && !all.warning) {
        for (const query of faqFallbackQueries(args.query)) {
          signal?.throwIfAborted();
          params = {page: 1, query}; attemptedQueries.push(query);
          all = await get(kind, params); cursor = {...cursor, q: query};
          if (all.data.pagination.total > 0 || all.warning) break;
        }
      }
      rememberContent(args.kind, params, all);
      if (args.mode === 'search') {
        data = contentPage(all, args, cursor);
        data.search = {requestedQuery: args.query ?? null, effectiveQuery: params.query ?? null, attemptedQueries,
          matchMode: !data.total ? 'none' : cursor.q ? 'keyword-fallback' : 'exact',
          candidatesOnly: Boolean(cursor.q),
          note: !data.total ? '仅已尝试关键词未命中，不代表站内没有资料；可澄清关键词。'
            : cursor.q ? '短词检索候选，必须按真实contentId读取正文并核对问题，不把候选当作答案。' : '关键词结果，答案需按正文核对。'};
      }
      else {
        const row = all.data.list.find(r => String(r.id) === args.contentId);
        if (!row) fail('content_locator_expired');
        data = {...contentProjection(row, args.kind, true), coverage: '从该ID已验证的来源列表页读取，未调用独立详情或阅读计数接口'};
        missingFields.push('detailUrl');
        if (data.imageDependency) missingFields.push('images');
        if (args.kind === 'guide' ? !data.content : !data.answer) missingFields.push(args.kind === 'guide' ? 'content' : 'answer');
      }
    }
    if (args.action === 'dictionary') {
      const all = await get(args.kind === 'effect' ? 'effects' : 'items');
      let rows = args.kind === 'effect' ? all.data : Object.values(all.data).flat();
      if (args.entryId) rows = rows.filter(r => String(r.id) === args.entryId);
      if (args.query) rows = rows.filter(r => [r.name, r.itemKey].filter(Boolean).some(s => normalize(s).includes(normalize(args.query))));
      data = pageRows(rows.map(r => dictionaryProjection(r, args.kind)), args, all.hash);
    }
    if (args.action === 'codes') {
      const all = await get('codes');
      const rows = all.data.filter(r => !args.server || normalize(r.server) === normalize(args.server));
      data = {items: rows.slice(0, args.limit ?? 5).map(r => ({code: text(r.code), server: text(r.server), effectiveDate: r.effectiveDate ?? null,
        expiryDate: r.expiryDate ?? null, remark: text(r.remark), updatedAt: r.updateTime ?? null})),
        coverage: '仅上游最新50条中的匹配项', timezone: null, redemptionVerified: false, validity: '上游时间未带时区，保留原值；未验证账号可兑换'};
    }
    if (args.action === 'news') {
      if (args.kind === 'wiki_update') {
        const all = await get('wikiUpdates');
        data = {...pageRows(all.data.map(r => ({id: String(r.id), title: text(r.title), date: r.date ?? null, content: text(r.content), updatedAt: r.updateTime ?? null})), args, all.hash),
          coverage: 'wiki最新50条版本日志，属于网站更新'};
      } else {
        let page = 1;
        if (args.cursor) {
          let cursor; try {cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString());} catch {fail('invalid_cursor');}
          if (cursor.server !== (args.server ?? null) || !Number.isInteger(cursor.page) || cursor.page < 1 || cursor.page > 1000 || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= 10) fail('invalid_cursor');
          page = cursor.page;
        }
        const all = await get('gameNews', {page, ...(args.server ? {server: args.server === '国服' ? 1 : 2} : {})});
        const upstream = all.data;
        let offset = 0;
        if (args.cursor) {
          const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString());
          if (cursor.hash !== null && cursor.hash !== all.hash) fail('cursor_expired');
          if (cursor.hash === null && cursor.offset !== 0) fail('invalid_cursor'); offset = cursor.offset;
        }
        const rows = upstream.list.slice(offset, offset + (args.limit ?? 5));
        let nextCursor = null;
        if (offset + rows.length < upstream.list.length) nextCursor = {server: args.server ?? null, page, offset: offset + rows.length, hash: all.hash};
        else if (upstream.list.length && page * 10 < upstream.pagination.total) nextCursor = {server: args.server ?? null, page: page + 1, offset: 0, hash: null};
        // A new-page cursor has no snapshot yet. Same-page cursors always bind to the exact response hash.
        if (nextCursor) nextCursor = Buffer.from(JSON.stringify(nextCursor)).toString('base64url');
        data = {items: rows.map(r => {
          const relative = typeof r.url === 'string' && /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.pdf$/.test(r.url) && !r.url.includes('..') ? r.url : null;
          return {id: String(r.id), title: text(r.title), server: r.server === 1 ? '国服' : r.server === 2 ? '国际服' : '来源未注明', updatedAt: r.updateTime ?? null,
            url: relative ? 'https://assets2.e7.wiki/announcement' + relative : null, bodyExtracted: false};
        }), total: upstream.pagination.total, nextCursor, coverage: '仅公告目录，正文PDF未解析'};
      }
    }
    signal?.throwIfAborted();
    const sources = [...new Map(resources.map(r => [r.url + r.hash, {url: r.url, fetchedAt: new Date(r.fetchedAt).toISOString(),
      checkedAt: new Date(r.checkedAt).toISOString(), upstreamUpdatedAt: null, stale: r.stale, ...(r.warning ? {warning: r.warning} : {})}])).values()];
    return boundResult({status, action: args.action, data, source: 'E7·WIKI', sources, stale: sources.some(r => r.stale), missingFields,
      externalContent: {untrusted: true, source: 'api'}});
  }
}
