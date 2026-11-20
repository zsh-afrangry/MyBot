import test from 'node:test';
import assert from 'node:assert/strict';
import {createBilibiliPublicSource} from '../../packages/media-source/bilibili.js';

const first = 'BV1ab2cd3EF4';
const next = 'BV2ab2cd3EF4';
const last = 'BV3ab2cd3EF4';
const popular = (...ids) => Response.json({code:0,data:{list:ids.map(bvid => ({bvid,title:'LIST_TITLE',desc:'LIST_ONLY'}))}});
const detail = (id, fields = {}) => Response.json({code:0,data:{bvid:id,state:0,rights:{pay:0,ugc_pay:0,arc_pay:0},
  title:'合成的详情标题', desc:'详情页公开简介', ...fields}});

test('the public list only discovers links; anonymous detail reads must have their own matching description', async () => {
  const calls = [];
  const source = createBilibiliPublicSource({fetchPage:async (url, options) => {
    calls.push(url);
    assert.equal(options.method,'GET');
    assert.equal(options.credentials,'omit');
    assert.equal(options.redirect,'error');
    assert.deepEqual(options.headers,{accept:'application/json'});
    assert(options.signal instanceof AbortSignal);
    switch (calls.length) {
      case 1: return popular('https://private.example/',first,first,next,last);
      case 2: return detail(first,{rights:{pay:1}});
      case 3: return detail(first); // Another video's text is not evidence for the selected link.
      case 4: return detail(last,{account:'PRIVATE_PAYLOAD_FIELD'});
      default: throw Error('unexpected_request');
    }
  }});
  assert.deepEqual(await source(),{status:'read',page:{
    url:`https://www.bilibili.com/video/${last}/`, title:'合成的详情标题', excerpt:'详情页公开简介',
  }});
  assert.deepEqual(calls,[
    'https://api.bilibili.com/x/web-interface/popular?pn=1&ps=8',
    ...[first,next,last].map(id => `https://api.bilibili.com/x/web-interface/view?bvid=${id}`),
  ]);
});

test('empty, restricted or redirected details do not use a list snippet or request extra candidates', async () => {
  const responses = [
    popular(first,next,last,'BV4ab2cd3EF4'), detail(first,{desc:'  '}),
    detail(next,{is_upower_exclusive:true}), detail(last,{redirect_url:'https://example.test/'}),
  ];
  const source = createBilibiliPublicSource({fetchPage:async () => responses.shift()});
  assert.deepEqual(await source(),{status:'not_read',reason:'no_public_description'});
  assert.equal(responses.length,0);
});

test('refusals, malformed bodies and excessive responses stop the read', async () => {
  const failures = [
    new Response('unavailable',{status:412}),
    new Response(null,{status:302,headers:{location:'https://example.test/'}}),
    new Response('<html>please log in</html>',{headers:{'content-type':'text/html'}}),
    Response.json({code:-101,data:{list:[{bvid:first}]}}),
    new Response('invalid',{headers:{'content-type':'application/json'}}),
    Response.json({code:0,data:{list:[],padding:'x'.repeat(256 * 1024)}}),
  ];
  for (const failure of failures) {
    let calls = 0;
    const source = createBilibiliPublicSource({fetchPage:async () => { calls++; return failure; }});
    assert.deepEqual(await source(),{status:'unavailable',reason:'bilibili_source_unavailable'});
    assert.equal(calls,1);
  }
});
