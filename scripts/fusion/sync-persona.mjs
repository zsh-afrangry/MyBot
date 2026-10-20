// Sync shared persona and trusted-role relationships for registered identities. Contract: config/README.md, docs/24 and docs/25.
// Never copies memory, personal facts, histories or credentials; no runtime/model configuration writes.
import fs from 'node:fs';
import path from 'node:path';
import {STATE_DIR,REPO_ROOT} from './lib/legacy-source.mjs';
import {personaFiles,applyPersonaFile} from '../../chatbot/packages/access-control/workspaces.js';
const argv=new Set(process.argv.slice(2)),apply=argv.has('--apply'),diff=apply||argv.has('--diff');
const {files,roleFile}=personaFiles(REPO_ROOT,STATE_DIR),changes=[];
for(const [file,content] of files){
 if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('persona_symlink_rejected');
 if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==content)changes.push(file);
}
if(diff){for(const file of changes)console.log('DIFFERS '+path.relative(STATE_DIR,file));console.log('role card: '+roleFile);}
if(!changes.length){console.log(`persona in sync with ${roleFile} (${files.size} workspace file(s) match)`);}
else if(!apply){console.error(`persona DRIFT: ${changes.length} file(s); run --apply`);process.exitCode=1;}
else{for(const file of changes)applyPersonaFile(file,files.get(file));console.log(`persona applied: ${changes.length} files; memory/history/model/credentials untouched`);}
