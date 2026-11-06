// Pin the local SDK installation and link read-only dependencies; never install over it.
import fs from 'node:fs';
import path from 'node:path';
import {OPENCLAW_RELEASE} from './lib/openclaw-release.mjs';
const root='/home/afrangry/kurumi-fusion',sdk='/home/afrangry/.npm-global/lib/node_modules/openclaw';
for(const [name,target,version] of [['openclaw',sdk,OPENCLAW_RELEASE.version],['ws',`${sdk}/node_modules/ws`,OPENCLAW_RELEASE.wsVersion]]){
 if(JSON.parse(fs.readFileSync(`${target}/package.json`)).version!==version)throw Error(`Expected ${name} ${version}; re-run contract acceptance before upgrading`);
 fs.mkdirSync(`${root}/node_modules`,{recursive:true});const link=path.join(root,'node_modules',name);
 if(fs.existsSync(link)){if(fs.realpathSync(link)!==fs.realpathSync(target))throw Error(`Unexpected dependency ${name}`);}else fs.symlinkSync(target,link,'dir');
}
console.log('Pinned local dependencies verified.');
