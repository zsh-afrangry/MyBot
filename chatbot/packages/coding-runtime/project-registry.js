// The live coding service owns task/reconciliation state and validates proposed registry edits.
const key = Symbol.for('kurumi.coding-runtime.project-registries.v1');
const registries = globalThis[key] ??= new Map();
const unavailable = () => Object.assign(Error('coding_project_registry_unavailable'), {code: 'coding_project_registry_unavailable'});

export function attachProjectRegistry(root, inspect) {
  if (registries.has(root)) throw unavailable();
  registries.set(root, inspect);
  return () => {
    if (registries.get(root) === inspect) registries.delete(root);
  };
}

export function inspectProjectMutation(active, intent, id, projects, candidate) {
  const inspect = registries.get(active?.root);
  if (!inspect) throw unavailable();
  return inspect(active, intent, id, projects, candidate);
}
