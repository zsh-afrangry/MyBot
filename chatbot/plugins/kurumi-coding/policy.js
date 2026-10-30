// Pure values shared by the domain store and execution boundary.
import {createHash} from 'node:crypto';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const fail = code => Object.assign(Error(code), {code});
export const policyHash = (project, config) => digest(JSON.stringify({id: project.id, root: project.root, branch: project.branch, checks: project.checks,
  ...(config ? {writeBoundary: config.writeBoundary, dsh: config.dsh, state: config.root, worktrees: config.worktrees} : {})}));
export function taskText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw fail('invalid_coding_task');
  return text;
}
