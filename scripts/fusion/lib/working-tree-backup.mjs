// Preserve the final working tree, including tracked binary edits/deletions/renames and untracked files.
// The Git index staging distinction is intentionally not restored.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
export function captureWorkingTree(dir,dest,name){
 const run=(cmd,args,opts={})=>{const r=spawnSync(cmd,args,{cwd:dir,encoding:'utf8',maxBuffer:128*1024*1024,...opts});if(r.status!==0)throw Error(`${cmd} working-tree capture failed: ${r.stderr||r.error}`);return r.stdout;};
 const patch=run('git',['diff','--binary','--full-index','--no-ext-diff','HEAD']);
 if(patch)fs.writeFileSync(path.join(dest,`${name}-uncommitted.patch`),patch,{mode:0o600});
 const files=run('git',['ls-files','-z','--others','--exclude-standard']).split('\0').filter(Boolean);
 if(files.length){const out=path.join(dest,`${name}-untracked.tar`);run('tar',['-C',dir,'-cf',out,'--null','-T','-'],{input:files.join('\0')+'\0'});fs.chmodSync(out,0o600);}
 return files.map(f=>`${name}:${f}`);
}
