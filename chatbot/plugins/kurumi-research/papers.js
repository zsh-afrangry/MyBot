// Public scholarly sources only. PDF parsing/rendering executes in an isolated namespace.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {runSandbox} from '../kurumi-tasks/sandbox.js';
const hosts=new Set(['arxiv.org','export.arxiv.org','aclanthology.org','openreview.net','proceedings.mlr.press','proceedings.neurips.cc']);
const maxBytes=25*1024*1024;
export function paperUrl(input){
 const url=new URL(input);if(url.protocol!=='https:'||url.username||url.password||url.port||!hosts.has(url.hostname)||url.hash)throw Error('仅支持已配置的公开学术PDF源（arXiv、ACL、OpenReview、PMLR、NeurIPS）');
 if([...url.searchParams.keys()].some(k=>url.hostname!=='openreview.net'||k!=='id'))throw Error('Unsupported PDF URL parameters');
 if(url.hostname==='arxiv.org'||url.hostname==='export.arxiv.org'){
  const match=url.pathname.match(/^\/(?:pdf|abs)\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?$/u);if(!match)throw Error('Invalid arXiv identifier');return `https://arxiv.org/pdf/${match[1]}`;
 }
 return url.href;
}
function directory(workspace){const root=fs.realpathSync(workspace),dir=path.join(root,'papers');fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.realpathSync(dir)!==dir)throw Error('Invalid paper directory');return {root,dir};}
function managedFile(dir,name){const file=path.join(dir,name);try{if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('Paper artifact must be a regular file');}catch(e){if(e.code!=='ENOENT')throw e;}return file;}
const pending=new Map();
export async function downloadPaper(workspace,input,options={}){
 const key=fs.realpathSync(workspace)+':'+paperUrl(input);
 if(pending.has(key))return pending.get(key);
 const job=downloadPaperOnce(workspace,input,options).finally(()=>pending.delete(key));pending.set(key,job);return job;
}
async function downloadPaperOnce(workspace,input,{signal,fetcher=fetch}={}){
 const url=paperUrl(input),{root,dir}=directory(workspace),id=createHash('sha256').update(url).digest('hex').slice(0,16),pdf=managedFile(dir,id+'.pdf');
 signal?.throwIfAborted();const metadata=managedFile(dir,id+'.json');
 if(fs.existsSync(metadata)){const saved=JSON.parse(fs.readFileSync(metadata,'utf8'));if(saved.url!==url||!fs.existsSync(pdf)||createHash('sha256').update(fs.readFileSync(pdf)).digest('hex')!==saved.sha256)throw Error('Cached PDF integrity mismatch');return saved;}
 const response=await fetcher(url,{redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)});
 if(response.status!==200)throw Error(`PDF source HTTP ${response.status}; no redirects or credentials attempted`);
 if(Number(response.headers.get('content-length'))>maxBytes)throw Error('PDF exceeds 25 MiB');
 const parts=[];let size=0;for await(const part of response.body){size+=part.length;if(size>maxBytes)throw Error('PDF exceeds 25 MiB');parts.push(Buffer.from(part));}
 const bytes=Buffer.concat(parts);if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw Error('Source did not return a PDF');signal?.throwIfAborted();
 const temp=path.join(dir,id+'.'+randomUUID()+'.tmp');fs.writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});fs.renameSync(temp,pdf);
 const raw=managedFile(dir,id+'.raw.txt');const result=await runSandbox({root},['/usr/bin/prlimit','--as=1073741824','--fsize=16777216','--cpu=20','--','/usr/bin/pdftotext','-layout',`/workspace/papers/${id}.pdf`,`/workspace/papers/${id}.raw.txt`],{signal,timeoutMs:30000});if(result.code!==0)throw Error('PDF text extraction failed or cancelled');
 if(fs.statSync(raw).size>10*1024*1024)throw Error('Extracted PDF exceeds text budget');
 const pages=fs.readFileSync(raw,'utf8').split('\f');if(pages.at(-1)?.trim()==='')pages.pop();if(!pages.length||pages.length>500)throw Error('Unsupported PDF page count');
 const text=managedFile(dir,id+'.txt');fs.writeFileSync(text,pages.map((p,i)=>`\n=== PDF PAGE ${i+1} ===\n${p}`).join('\n'),{mode:0o600});
 const data={id,url,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,pages:pages.length,textPath:text,pdfPath:pdf,downloadedAt:new Date().toISOString(),textCharacters:pages.join('').length,limitation:'Text extraction may lose formula/table layout. Use page view for visual evidence; page numbers refer to PDF file pages.'};
 fs.writeFileSync(metadata,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});return data;
}
export function readPaperText(workspace,id,offset=0,limit=30000){
 if(!/^[a-f0-9]{16}$/.test(id)||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>30000)throw Error('Invalid paper text range');
 const {dir}=directory(workspace),metadata=JSON.parse(fs.readFileSync(managedFile(dir,id+'.json'),'utf8')),text=fs.readFileSync(managedFile(dir,id+'.txt'),'utf8');
 return {id,url:metadata.url,sha256:metadata.sha256,offset,totalCharacters:text.length,text:text.slice(offset,offset+limit),nextOffset:offset+limit<text.length?offset+limit:null};
}
export async function readPaperPage(workspace,id,page,{signal,visual=true}={}){
 if(!/^[a-f0-9]{16}$/.test(id))throw Error('Invalid paper ID');const {root,dir}=directory(workspace),data=JSON.parse(fs.readFileSync(managedFile(dir,id+'.json'),'utf8'));
 if(!Number.isInteger(page)||page<1||page>data.pages)throw Error('Invalid PDF page');
 const raw=fs.readFileSync(managedFile(dir,id+'.raw.txt'),'utf8').split('\f')[page-1];let image;
 if(visual){const png=managedFile(dir,`${id}-page-${page}.png`);if(!fs.existsSync(png)){const result=await runSandbox({root},['/usr/bin/prlimit','--as=1073741824','--fsize=16777216','--cpu=20','--','/usr/bin/pdftoppm','-f',String(page),'-l',String(page),'-singlefile','-scale-to','1600','-png',`/workspace/papers/${id}.pdf`,`/workspace/papers/${id}-page-${page}`],{signal,timeoutMs:30000});if(result.code!==0)throw Error('PDF page rendering failed or cancelled');}if(fs.statSync(png).size>8*1024*1024)throw Error('Rendered page too large');image=png;}
 return {id,url:data.url,page,totalPages:data.pages,text:raw.slice(0,20000),truncated:raw.length>20000,...(image?{image}: {})};
}
