// Operator-owned project registry. Model tools accept IDs, never roots or commands.
import fs from 'node:fs';
import path from 'node:path';

// Roots a background worker must never own. The registry is operator-owned, but a bad entry (or a
// future edit) must not be able to point a worker at the runtime state, the recovery backups, or a
// retained original component. Extend at runtime with KURUMI_PROTECTED_ROOTS (colon-separated).
const STATE='/home/afrangry/.openclaw-fusion';
const PROTECTED_ROOTS=[
 '/home/afrangry/.openclaw',      // legacy original, preserved until archived
 '/home/afrangry/kurumi-backups', // recovery point: a worker must never rewrite it
 '/home/afrangry/kurumi-baselines', // legacy rollback snapshots
 '/home/afrangry/snowluma',       // retained transport component
 '/home/afrangry/桌面/qq-bridge',  // bridge original
 '/home/afrangry/.npm-global',    // pinned OpenClaw SDK installation
 '/home/afrangry/kurumi-fusion'   // live source tree (workers use their own copy)
];
function assertNotProtected(root){
 for(const original of [...PROTECTED_ROOTS,...(process.env.KURUMI_PROTECTED_ROOTS??'').split(':').filter(Boolean)]){
  if(root.startsWith(original+'/')||root===original)throw Error('Preserved original cannot be a project worker root');
 }
 // The isolated runtime is protected too, except the worker workspaces under projects/.
 if((root===STATE||root.startsWith(STATE+'/'))&&!root.startsWith(`${STATE}/projects/`))throw Error('Fusion runtime state cannot be a project worker root');
}
export function projectCatalog(cfg){
 const file=path.join(path.dirname(cfg.channels['kurumi-qq'].stateDir),'projects.json');
 if(!fs.existsSync(file))throw Error('Project registry unavailable');
 if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('Invalid project registry');
 const registry=JSON.parse(fs.readFileSync(file,'utf8'));if(registry.version!==1||!Array.isArray(registry.projects))throw Error('Unsupported project registry');
 const ids=new Set();
 return registry.projects.map(project=>{
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(project.id)||ids.has(project.id)||project.agentId!==`project-${project.id}`)throw Error('Invalid project identity');ids.add(project.id);
  if(!path.isAbsolute(project.root)||fs.realpathSync(project.root)!==project.root)throw Error('Project root must be canonical');
  assertNotProtected(project.root);
  if(!fs.lstatSync(path.join(project.root,'.git')).isDirectory())throw Error('Project needs an independent Git directory');
  if(!Array.isArray(project.checks)||!project.checks.length)throw Error('Project requires checks');
  return project;
 });
}
export function workerProject(ctx,cfg){
 const project=projectCatalog(cfg).find(p=>p.agentId===ctx.agentId);
 if(!project||fs.realpathSync(ctx.workspaceDir)!==project.root)throw Error('Unexpected worker workspace');return project;
}
