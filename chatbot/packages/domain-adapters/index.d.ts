export interface AdapterSelection {policy: string; store: string}
export interface ResolvedAdapters<P, S, O> {
  readonly policy: P;
  readonly policyId: string;
  readonly storeId: string;
  openStore(options: O): S;
}
export interface AdapterRegistry<P, S, O> {
  registerPolicy(id: string, policy: P): () => void;
  registerStore(id: string, open: (options: O) => S): () => void;
  ids(): {policies: string[]; stores: string[]};
  resolve(selection: AdapterSelection): ResolvedAdapters<P, S, O>;
}
export function createAdapterRegistry<P, S, O>(options: {
  domain: string; policyMethods: readonly (keyof P)[]; storeMethods: readonly (keyof S)[];
}): AdapterRegistry<P, S, O>;
