// Reuse existing immutable dependency packages but bind the local confirmation core.
// Never link the entire node_modules directory: that would resolve the old core.
import fs from 'node:fs';
import path from 'node:path';
const repo='/home/afrangry/kurumi-fusion',old='/home/afrangry/.openclaw';
for(const relative of ['chatbot/packages/confirmation-core','chatbot/plugins/personal-confirmation','chatbot/plugins/personal-weather']){
 const source=path.join(old,relative,'node_modules'),target=path.join(repo,relative,'node_modules');fs.mkdirSync(target,{recursive:true});
 for(const name of fs.readdirSync(source)){
  if(name==='@kurumi'||name==='openclaw')continue;
  const link=path.join(target,name);if(!fs.existsSync(link))fs.symlinkSync(path.join(source,name),link,'dir');
 }
 if(relative.includes('/plugins/')){
  fs.mkdirSync(path.join(target,'@kurumi'),{recursive:true});
  for(const [name,location] of [['openclaw','/home/afrangry/.npm-global/lib/node_modules/openclaw'],['@kurumi/confirmation-core',path.join(repo,'chatbot/packages/confirmation-core')]]){
   const link=path.join(target,name);if(fs.existsSync(link)){if(fs.realpathSync(link)!==location)throw Error('Unexpected dependency '+link);}else fs.symlinkSync(location,link,'dir');
  }
 }
}
console.log('Domain dependencies linked; local confirmation core selected.');
