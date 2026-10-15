# Kurumi confirmation core

Shared confirmation governance for domain capabilities. This package has no
dependency on a weather provider, a business plugin, or the OpenClaw SDK.

Business plugins import `@kurumi/confirmation-core` through
`file:../../packages/confirmation-core`. Build this package before building its
consumers. Run `npm ci --ignore-scripts`, `npm run build`, and `npm test` here.

## Ownership

- A domain creates proposals from an owner-authorized tool context using
  `scopeFromToolContext` and registers them in its own database.
- A domain service registers a `ConfirmationBackendProvider` at startup and
  calls the returned unregister function at shutdown.
- `personal-confirmation` receives original QQ messages through `reply_dispatch`
  and calls `recordRegisteredConfirmation`. It owns no business database.
- Each provider opens its own store. Candidate lookup is read-only with respect
  to business facts; grant recording must recheck the expected proposal inside
  a local transaction. The coordinator closes every opened store.
- Grant consumption and the corresponding business update belong in the same
  domain transaction. A grant does not replace tool authorization.

All candidate lookups must succeed and exactly one candidate may exist across
providers. Duplicate ownership is rejected, not deduplicated. Registration uses
a versioned process-local symbol because host plugin loaders may evaluate more
than one copy of the package. It is an internal trusted-plugin API, not a tool
exposed to the model.

New databases permit domain names beyond the existing three domains. Existing
business database constraints are not migrated by `CREATE TABLE IF NOT EXISTS`.
New capabilities must provide their own storage adapter instead of adding their
tables or domain names to the weather plugin by default.

The confirmation grammar is bounded, not a natural-language authorization
classifier. Always show the text from `buildConfirmationInstruction`. Account
and conversation binding are required by the live ingress; legacy unbound
proposals must be recreated.

## Source boundaries

- `src/protocol.ts`: confirmation wording, parsing and short-code binding.
- `src/scope.ts`: conversation/identity scope construction and comparison.
- `src/types.ts`: shared contracts.
- `src/schema.ts` and `src/store.ts`: shared proposal/grant tables and operations;
  callers retain ownership of their business transaction.
- `src/registry.ts`: process-local backend registration and unique routing.
- `src/validation.ts`: internal scalar checks, not a domain language policy.

Consumers import the package root; internal helper exports are not package API.
`personal-confirmation` owns the QQ inbound adapter. Business intent word lists,
clarification hooks and reply replacement do not belong in this package. Current
integration and verification are documented in
[`docs/21`](../../../docs/21_后端职责分层与代码整理.md).
