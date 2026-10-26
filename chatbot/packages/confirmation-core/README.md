# Kurumi confirmation core

Shared confirmation governance without domain, provider or OpenClaw dependencies.
Build before consumers: `npm ci --ignore-scripts`, `npm run build`, `npm test`.

## Natural confirmation

The owner sees a frozen domain preview and can approve it in a later QQ message
without copying a code. The assistant reads real candidates through the narrow
`personal_confirmation` tool and resolves the current message to one proposal ID,
payload hash and domain. Ambiguity requires a question. Parameters changed by the
user require a new preview and a later confirmation.

- Domain stores own proposals, immutable business payloads and their transactions.
  Each provider registers on service startup and unregisters on shutdown.
- The interaction plugin captures the original trusted QQ message, binds the
  actual host run/session/tool call, and adds the current text to model context.
  Interaction hooks never issue a natural approval grant.
- Proposal tool results prepare a persistent preview; the final reply hook uses
  its exact text. Only successful QQ transport receipts for the full payload
  mark that preview presented. Missing/partial delivery remains unconfirmed.
- `confirmNaturalProposal` checks original direct-message provenance, age, scope,
  presentation and exact selection. Bare assent needs one latest preview or one
  trusted reply target. Multiple pending proposals can coexist; an explicit
  reference may select one. One original message can approve only one proposal.
- All backend lookups must succeed. Missing natural adapters and duplicate
  ownership fail closed, without a default-store fallback. Historical shared
  Profile/planning storage is narrowed by domain.
- Grants expire within five minutes and cannot outlive their proposal. Natural
  grants can be consumed only during the current trusted request; a newer owner
  message, run end, reset or process restart invalidates unconsumed authorization.
  Consumption and business updates belong in the same domain transaction.
  Mail consumes before SMTP, marks the proposal committed, and never retries a
  failed send by reusing approval. A grant never replaces identity permissions.

The text exclusions reject bounded negative, quoted, discussion and mixed-change
forms. They are not a target/title classifier or a complete semantic proof. The
assistant still resolves intent and reference; unclear ordinary acknowledgments
must not be promoted to authorization.

Existing explicit coded confirmations remain compatible via `protocol.ts` and
`recordRegisteredConfirmation`. New previews request natural confirmation. Old
proposals without a saved delivery proof need a new proposal/preview before the
natural path can authorize them. The additive `confirmation_previews` and
`natural_confirmation_grants` tables do not erase existing proposals or grants.

## Source boundaries

- `protocol.ts`: legacy code grammar and normalization.
- `scope.ts`, `types.ts`: trusted scope and shared contracts.
- `schema.ts`, `store.ts`: shared tables and transaction-level grant checks.
- `registry.ts`: backend lifecycle and legacy unique routing.
- `natural-store.ts`: domain-owned SQLite natural adapter and domain narrowing.
- `natural-service.ts`: candidate/selection/presentation coordination.
- `presentation.ts`: prepared-preview and successful-delivery correlation.
- `current-request.ts`: process-local trusted-request fence, without grants.

Consumers import the package root. Registration and receipt APIs are internal
trusted-plugin capabilities, never tools exposed directly to the model.
Current integration and verification: [docs/21](../../../docs/21_后端职责分层与代码整理.md).
