// Operator-owned project registry. Model tools accept IDs, never roots or commands.
import fs from 'node:fs';
import path from 'node:path';
export function projectCatalog(cfg){
 const file=path.join(path.dirname(cfg.channels['kurumi-qq'].stateDir),'projects.json');
 if(!fs.existsSync(file))throw Error('Project registry unavailable');
 if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('Invalid project registry');
 const registry=JSON.parse(fs.readFileSync(file,'utf8'));if(registry.version!==1||!Array.isArray(registry.projects))throw Error('Unsupported project registry');
 const ids=new Set();
 return registry.projects.map(project=>{
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(project.id)||ids.has(project.id)||project.agentId!==`project-${project.id}`)throw Error('Invalid project identity');ids.add(project.id);
  if(!path.isAbsolute(project.root)||fs.realpathSync(project.root)!==project.root)throw Error('Project root must be canonical');
  for(const original of ['/home/afrangry/.openclaw','/home/afrangry/snowluma','/home/afrangry/桌面/qq-bridge'])if(project.root===original||project.root.startsWith(original+'/'))throw Error('Preserved original cannot be a project worker root');
  if(!fs.lstatSync(path.join(project.root,'.git')).isDirectory())throw Error('Project needs an independent Git directory');
  if(!Array.isArray(project.checks)||!project.checks.length)throw Error('Project requires checks');
  return project;
 });
}
export function workerProject(ctx,cfg){
 const project=projectCatalog(cfg).find(p=>p.agentId===ctx.agentId);
 if(!project||fs.realpathSync(ctx.workspaceDir)!==project.root)throw Error('Unexpected worker workspace');return project;
}
