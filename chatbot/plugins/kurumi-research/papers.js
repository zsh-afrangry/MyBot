// Scholarly reading owns text/page extraction; shared source acquisition owns PDF bytes.
import fs from 'node:fs';
import {runSandbox} from '../../packages/sandbox/index.js';
import {paperUrl, downloadScholarlyPdf, paperDirectory as directory, paperFile as managedFile} from '../../packages/scholarly-source/index.js';
export {paperUrl};
const pending = new Map();
export async function downloadPaper(workspace, input, options = {}) {
 const key = fs.realpathSync(workspace) + ':' + paperUrl(input);
 options.signal?.throwIfAborted();
 if (options.signal) return prepareReading(workspace, input, options);
 if (pending.has(key)) return pending.get(key);
 const job = prepareReading(workspace, input, options).finally(() => pending.delete(key));
 pending.set(key, job); return job;
}
async function prepareReading(workspace, input, options) {
 const {signal, extractText = runSandbox} = options;
 const source = await downloadScholarlyPdf(workspace, input, options);
 const {root,dir} = directory(workspace), {id,url,pdfPath:pdf} = source;
 const metadata = managedFile(dir,id+'.json');
 if (fs.existsSync(metadata)) {
  const saved = JSON.parse(fs.readFileSync(metadata,'utf8'));
  if (saved.url !== url || saved.sha256 !== source.sha256) throw Error('Cached PDF integrity mismatch');
  return saved;
 }
 const raw=managedFile(dir,id+'.raw.txt');
 const result=await extractText({root},['/usr/bin/prlimit','--as=1073741824','--fsize=16777216','--cpu=20','--','/usr/bin/pdftotext','-layout',`/workspace/papers/${id}.pdf`,`/workspace/papers/${id}.raw.txt`],{signal,timeoutMs:30000});
 if(result.code!==0)throw Error('PDF text extraction failed or cancelled');
 if(fs.statSync(raw).size>10*1024*1024)throw Error('Extracted PDF exceeds text budget');
 const pages=fs.readFileSync(raw,'utf8').split('\f');if(pages.at(-1)?.trim()==='')pages.pop();if(!pages.length||pages.length>500)throw Error('Unsupported PDF page count');
 const text=managedFile(dir,id+'.txt');fs.writeFileSync(text,pages.map((p,i)=>`\n=== PDF PAGE ${i+1} ===\n${p}`).join('\n'),{mode:0o600});
 const data={...source,pages:pages.length,textPath:text,pdfPath:pdf,textCharacters:pages.join('').length,limitation:'Text extraction may lose formula/table layout. Use page view for visual evidence; page numbers refer to PDF file pages.'};
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
