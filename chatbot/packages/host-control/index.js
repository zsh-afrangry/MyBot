// A binding belongs to the host's config snapshot and service lifetime.
// Captured plugin modules in the same Gateway share the registry.
const registryKey = Symbol.for('kurumi.host-control.bindings.v1');
const bindings = globalThis[registryKey] ??= new WeakMap();

export function attachHostControl(config, control) {
  if (bindings.has(config)) throw Error('Host control already attached');
  bindings.set(config, control);
  return () => {
    if (bindings.get(config) === control) bindings.delete(config);
  };
}

export function registerHostToolBoundary(api) {
  if (typeof api.registerTrustedToolPolicy !== 'function') throw Error('Trusted tool policy host API required');
  api.registerTrustedToolPolicy({
    id: 'kurumi-access-control',
    description: 'Require identity authorization from the active host control service',
    evaluate(event, ctx) {
      const control = bindings.get(api.config);
      return control ? control.evaluate(event, ctx) : {block: true, blockReason: 'host_control_unavailable'};
    },
  });
}

export function reportAcceptedInbound(config, metadata) {
  return bindings.get(config)?.acceptInbound?.(metadata);
}
