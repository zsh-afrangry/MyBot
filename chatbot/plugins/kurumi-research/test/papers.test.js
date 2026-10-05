import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {paperUrl,downloadPaper,readPaperText,readPaperPage} from '../papers.js';
test('paper sources forbid local destinations, credentials, redirects and unsupported query parameters',()=>{
 assert.equal(paperUrl('https://arxiv.org/abs/2005.11401'),'https://arxiv.org/pdf/2005.11401');
 for(const url of ['http://arxiv.org/pdf/2005.11401','https://127.0.0.1/secret.pdf','file:///etc/hosts','https://user:pass@arxiv.org/pdf/2005.11401','https://arxiv.org.evil.test/pdf/x','https://arxiv.org/pdf/2005.11401?token=secret','https://arxiv.org:4430/pdf/2005.11401'])assert.throws(()=>paperUrl(url));
});
test('failed, redirected, oversized and non-PDF responses cannot become paper artifacts',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'paper-guard-'));try{
  for(const response of [new Response('',{status:302,headers:{location:'http://127.0.0.1'}}),new Response('',{status:200,headers:{'content-length':String(26*1024*1024)}}),new Response('<html>login</html>',{status:200})])await assert.rejects(downloadPaper(root,'https://arxiv.org/pdf/2005.11401',{fetcher:async()=>response}));
  assert.deepEqual(fs.readdirSync(path.join(root,'papers')),[]);
  await assert.rejects(readPaperPage(root,'../../escape',1));assert.throws(()=>readPaperText(root,'../../escape'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
