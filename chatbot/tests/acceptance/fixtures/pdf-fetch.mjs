// Runs only in the disposable media Gateway. Keep the QQ file URL boundary
// in the production adapter and substitute bytes at its download step.
import {pdf} from '../../papers/fixtures.mjs';

export const fixturePdfUrl = 'https://multimedia.nt.qq.com/kurumi-acceptance.pdf';
export const fixturePdf = () => pdf('Kurumi media acceptance');

if (process.env.OPENCLAW_STATE_DIR && process.env.OPENCLAW_CONFIG_PATH === process.env.OPENCLAW_STATE_DIR + '/openclaw.json'
  && /\/kurumi-media-acceptance-[^/]+$/u.test(process.env.OPENCLAW_STATE_DIR)) {
  const fetchLoopback = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === fixturePdfUrl) {
      options?.signal?.throwIfAborted();
      return Promise.resolve(new Response(fixturePdf(), {headers: {'content-type': 'application/pdf'}}));
    }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('Unexpected network request in the media fixture');
    return fetchLoopback(input, options);
  };
}
