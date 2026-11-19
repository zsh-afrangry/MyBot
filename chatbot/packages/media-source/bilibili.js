const PUBLIC_POPULAR = 'https://api.bilibili.com/x/web-interface/popular?pn=1&ps=8';
const PUBLIC_DETAIL = 'https://api.bilibili.com/x/web-interface/view';
const MAX_BYTES = 256 * 1024;
const MAX_DETAILS = 3;
const BV_ID = /^BV[0-9A-Za-z]{10}$/u;
const unavailable = () => new Error('bilibili_source_unavailable');

async function readJson(fetchPage, url, signal) {
  const response = await fetchPage(url, {
    method:'GET', credentials:'omit', redirect:'error', headers:{accept:'application/json'}, signal,
  });
  if (!response.ok || !response.body || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw unavailable();
  }
  const bytes = new Uint8Array(MAX_BYTES);
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (total + value.length > bytes.length) { await reader.cancel(); throw unavailable(); }
      bytes.set(value,total);
      total += value.length;
    }
  } finally { reader.releaseLock(); }
  const result = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,total)));
  if (result?.code !== 0 || !result.data || typeof result.data !== 'object') throw unavailable();
  return result.data;
}

function videoDescription(data, bvid) {
  if (data.bvid !== bvid || data.state !== 0 || data.redirect_url || data.is_upower_exclusive
    || data.is_upower_exclusive_with_qa || !data.rights || typeof data.rights !== 'object'
    || ['pay','ugc_pay','ugc_pay_preview','arc_pay'].some(key => data.rights[key])
    || typeof data.title !== 'string' || !data.title.trim()
    || typeof data.desc !== 'string' || !data.desc.trim()) return null;
  // The public description is source text. The popular list, video, comments and subtitles are separate.
  return {url:`https://www.bilibili.com/video/${bvid}/`, title:data.title, excerpt:data.desc};
}

// A fixed, anonymous public source. No URL, query, identity or chat context is accepted.
export function createBilibiliPublicSource({fetchPage = globalThis.fetch} = {}) {
  return async ({signal} = {}) => {
    const timeout = AbortSignal.timeout(8000);
    const deadline = signal ? AbortSignal.any([signal,timeout]) : timeout;
    try {
      deadline.throwIfAborted();
      const popular = await readJson(fetchPage,PUBLIC_POPULAR,deadline);
      if (!Array.isArray(popular.list)) throw unavailable();
      const ids = [...new Set(popular.list.slice(0,8).map(row => row?.bvid)
        .filter(id => typeof id === 'string' && BV_ID.test(id)))].slice(0,MAX_DETAILS);
      for (const bvid of ids) {
        const data = await readJson(fetchPage,`${PUBLIC_DETAIL}?bvid=${bvid}`,deadline);
        deadline.throwIfAborted();
        const page = videoDescription(data,bvid);
        if (page) return {status:'read', page};
      }
      return {status:'not_read', reason:'no_public_description'};
    } catch {
      signal?.throwIfAborted();
      return {status:'unavailable', reason:'bilibili_source_unavailable'};
    }
  };
}
