// Authorized public-paper HTTP + actual managed-PDF validation. No model/QQ/mail call.
// Private runtime acceptance state only; report in docs/verification/paper-translation-2026-10-17/.
// Development owner: docs/22_论文PDF翻译与文件投递.md.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {PaperService} from '../../plugins/kurumi-papers/service.js';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const root='/home/afrangry/.openclaw-fusion/paper-acceptance/web-download';
const out=path.join(repo,'docs/verification/paper-translation-2026-10-17/download.json');
const report={at:new Date().toISOString(),boundary:'Actual public arXiv PDF download and networkless PDF inspection; private acceptance catalog only. No model/QQ/mail call.'};
const service=new PaperService({root,liveTranslationEnabled:false});
try{
 report.document=await service.fetch('https://arxiv.org/abs/1706.03762',{signal:AbortSignal.timeout(90000)});
 assert(report.document.pages>1);assert.equal(service.documents.get(report.document.id).content.length,report.document.bytes);
 report.passed=true;
}catch(error){report.passed=false;report.error=error.code??'public_paper_download_failed';process.exitCode=1;}
finally{fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,error:report.error,evidence:out}));}
