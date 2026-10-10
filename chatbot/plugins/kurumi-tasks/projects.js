// Operator-owned project registry. Model tools accept IDs, never roots or commands.
import fs from 'node:fs';
import path from 'node:path';
import {RUNTIME_STATE, assertNotProtectedRoot} from './protected-roots.js';

// The protected-root list lives in protected-roots.js so the runtime and the operator CLI
// (scripts/fusion/register-project.mjs) cannot drift apart. See that file for the rationale.
const STATE = RUNTIME_STATE;
function assertNotProtected(root){
 assertNotProtectedRoot(root);
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
