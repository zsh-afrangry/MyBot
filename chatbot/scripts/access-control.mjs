// Read-only policy validation/matrix. No runtime writes, model, network or delivery. Contract: docs/24.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {validatePolicy,PERMISSIONS} from '../packages/access-control/index.js';
const args=process.argv.slice(2),allowed=new Set(['--check','--matrix','--json']);
if(args.some(x=>!allowed.has(x)))throw Error('Usage: node chatbot/scripts/access-control.mjs [--check|--matrix|--json]');
const policy=validatePolicy(JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../config/access-control.json',import.meta.url)),'utf8')));
if(args.includes('--json'))console.log(JSON.stringify(policy,null,2));
else if(args.includes('--matrix')){
 console.log(['QQ','性质','角色','启用','到期',...PERMISSIONS,'邮件目标'].join('\t'));
 for(const row of policy.subjects)console.log([row.qq,row.kind,row.role,row.enabled?'是':'否',row.expiresAt??'',...PERMISSIONS.map(p=>row.permissions[p]===true?'允许':'拒绝'),row.mailRecipients.join(',')].join('\t'));
}else console.log(`access policy valid: version=${policy.version}, revision=${policy.revision}, subjects=${policy.subjects.length}; groups disabled`);
