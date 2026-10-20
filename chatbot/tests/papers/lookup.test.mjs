// Offline paper-by-name lookup: metadata-only matching, recorded titles, bounded results. Contract: docs/22.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Documents,searchText,paperTitle} from '../../packages/documents/index.js';
import {PaperService} from '../../plugins/kurumi-papers/service.js';
import {pdf} from './fixtures.mjs';
const inspect=async()=>({pages:1});
function root(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-lookup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('Normalized text ignores case, width and punctuation but keeps any script',()=>{
  assert.equal(searchText('  Attention-Is ALL  you_Need! '),'attention is all you need');
  assert.equal(searchText('ＢＥＲＴ：Ｐｒｅ－ｔｒａｉｎｉｎｇ'),'bert pre training');
  assert.equal(searchText('视觉 文本压缩（DeepSeek-OCR）'),'视觉 文本压缩 deepseek ocr');
  assert.equal(paperTitle(' A\n\tTitle\x00 '),'A Title');assert.equal(paperTitle('x'.repeat(400)).length,300);
  for(const empty of [undefined,null,'',' \n '])assert.equal(paperTitle(empty),undefined);
});

test('Find matches every term against filename, recorded title and source URL only',async t=>{
  const docs=new Documents(root(t));
  const upload=await docs.add(pdf('upload'),{filename:'Attention Is All You Need.pdf',source:{type:'qq'}},{inspect});
  const titled=await docs.add(pdf('titled'),{filename:'paper-0123456789abcdef.pdf',source:{type:'scholarly',url:'https://arxiv.org/pdf/2609.32536v1',title:'视觉文本压缩：DeepSeek-OCR 研究'}},{inspect});
  const artifact=await docs.add(pdf('artifact'),{kind:'artifact',filename:'Attention Is All You Need-dual.pdf',source:{type:'translation',inputId:upload.id}},{inspect});
  const ids=(query,options)=>docs.find(query,options).map(d=>d.id).sort();
  assert.deepEqual(ids('attention need'),[upload.id,artifact.id].sort());
  assert.deepEqual(ids('ATTENTION—need',{kind:'input'}),[upload.id]);
  assert.deepEqual(ids('deepseek ocr'),[titled.id]);
  assert.deepEqual(ids('文本压缩'),[titled.id]);
  assert.deepEqual(ids('2609.32536'),[titled.id]);
  assert.deepEqual(ids('attention transformer'),[]);
  // Content bytes and absolute paths never appear in results; PDF text is not searched.
  assert.deepEqual(ids('upload'),[]);
  for(const d of docs.find('attention'))assert.equal('path' in d||'content' in d,false);
  for(const bad of ['','  ','!!!','x'.repeat(301),42,undefined,Array(21).fill('a').join(' ')])
    assert.throws(()=>docs.find(bad),{code:'invalid_document_query'});
});

test('Find scans the whole catalog, newest first, and bounds the result count',async t=>{
  const docs=new Documents(root(t));
  const oldest=await docs.add(pdf('old'),{filename:'rare-name.pdf'},{inspect});
  fs.writeFileSync(docs.recordFile(oldest.id),JSON.stringify({...docs.describe(oldest.id),createdAt:'2000-01-01T00:00:00.000Z'}));
  for(let n=0;n<55;n++)await docs.add(pdf('bulk '+n),{filename:`bulk-${n}.pdf`},{inspect});
  assert.equal(docs.list({limit:50}).some(d=>d.id===oldest.id),false);
  assert.deepEqual(docs.find('rare name').map(d=>d.id),[oldest.id]);
  assert.equal(docs.find('bulk').length,10);assert.equal(docs.find('bulk',{limit:500}).length,50);
  const found=docs.find('bulk',{limit:50});
  assert.deepEqual(found.map(d=>d.createdAt),[...found.map(d=>d.createdAt)].sort().reverse());
});

test('Fetch records a sanitized title for later lookup; repeat fetch keeps the first record',async t=>{
  const dir=root(t);let downloads=0;
  const download=async cache=>{downloads++;const file=path.join(cache,'source.pdf');fs.mkdirSync(cache,{recursive:true});fs.writeFileSync(file,pdf('fetched'));return {id:'0123456789abcdef',url:'https://arxiv.org/pdf/2609.32536v1',pdfPath:file};};
  const service=new PaperService({root:dir},{download,inspect});
  const record=await service.fetch('https://arxiv.org/abs/2609.32536v1',{title:'  DeepSeek-OCR:\nContexts Optical Compression '});
  assert.deepEqual(record.source,{type:'scholarly',url:'https://arxiv.org/pdf/2609.32536v1',title:'DeepSeek-OCR: Contexts Optical Compression'});
  assert.deepEqual(service.documents.find('optical compression').map(d=>d.id),[record.id]);
  const again=await service.fetch('https://arxiv.org/abs/2609.32536v1',{title:'Other title'});
  assert.equal(again.id,record.id);assert.equal(again.source.title,record.source.title);assert.equal(downloads,2);
  const untitled=new PaperService({root:root(t)},{download,inspect});
  assert.equal('title' in (await untitled.fetch('https://arxiv.org/abs/2609.32536v1')).source,false);
});
