# Host acceptance tests

This directory is test infrastructure, not a production plugin. Its modules
depend on production capabilities; production modules never import these tests.

Build `chatbot/packages/confirmation-core`, `chatbot/plugins/personal-confirmation`
and `chatbot/plugins/personal-weather` first, in that order. On the deployment
host, from the repository root, run:

Build `chatbot/plugins/personal-search` as well for the search cases.

```sh
node chatbot/tests/acceptance/run.mjs
node chatbot/tests/acceptance/run.mjs --boundaries
node chatbot/tests/acceptance/run-model.mjs
node chatbot/tests/acceptance/run-reminder-expiry.mjs
node chatbot/tests/acceptance/run-agent-errors.mjs profile-hash
node chatbot/tests/acceptance/run-agent-errors.mjs expired
node chatbot/tests/acceptance/run-agent-errors.mjs unapproved
node chatbot/tests/acceptance/run-agent-errors.mjs confirm
node chatbot/tests/acceptance/run-agent-errors.mjs confirm natural-a
node chatbot/tests/acceptance/run-agent-errors.mjs reminder-proposal natural-b
node --test chatbot/tests/acceptance/call-analysis.test.mjs
node chatbot/tests/acceptance/run-agent-errors.mjs search
node chatbot/tests/acceptance/run-agent-errors.mjs search-error
node chatbot/tests/acceptance/run-real-cron.mjs
node chatbot/tests/acceptance/run-search-provider.mjs
```

Each command starts a new process and allocates a new `kurumi-acceptance-*`
directory. `KURUMI_ACCEPTANCE_PARENT` optionally sets its existing parent;
otherwise the OS temporary directory is used. Reports and SQLite fixtures are
retained there. No production database is copied into fixtures. No production
Gateway restart is necessary to load new code into these fresh test processes.

- `host-driver.mjs`: actual public Host dispatch SDK and actual confirmation
  plugin; synthetic QQ input and a local reply collector. No QQ network delivery.
- `domain-fixture.mjs`: isolated domain stores, actual tool factories, and fake
  scheduler. Profile lookup uses a fixture only in the cross-domain test.
- `run.mjs`: deterministic sequential checks, with SQL snapshots before/after
  each test. A failure aborts the stage and is retained in its report.
- `verify-restart.mjs`: a fresh child process verifies durable commit idempotency.
- `model-driver.mjs`: the configured primary model using the installed Anthropic
  SDK, with at most six tool rounds per turn and no provider retries. Only three
  planning tools are exposed. It reads the environment SecretRef in memory;
  credentials and request headers are not written to reports.
- `run-model.mjs`: natural-language draft, bare confirmation rejection, exact
  confirmation/commit, and repeat confirmation. Tool results and SQL evidence
  are retained in `model-report.json`.
- `run-reminder-expiry.mjs`: configured-model reminder draft and exact UTC/local
  expiry display, checked against isolated SQLite. Exposes only the proposal
  tool; no commit, Cron call, or QQ delivery. Evidence omits raw provider responses.

`OPENCLAW_HOST_ROOT` overrides the installed Host path. The model driver reads
the existing configuration and `.env` under `KURUMI_SOURCE_ROOT` (default
`/home/afrangry/.openclaw`); it currently supports `anthropic-messages` with an
environment SecretRef and fails explicitly for other configurations.

`run-agent-errors.mjs` separately exercises the default Host agent through the
same public buffered dispatcher used by QQ, with real domain tools and isolated
SQLite. It exposes only scenario-specific tools and collects delivery locally.
Error cases (`missing`, `hash`, `profile-hash`, `expired`, `unapproved`) supply no grants.
`confirm` loads the real confirmation plugin and checks deadline display, the
complete backend confirmation instruction, commit and replay across three
default-Agent turns. Its proposal request does not ask for a confirmation phrase.
`reminder-proposal` uses the ordinary ten-minute reminder request, requires one
successful proposal and the complete confirmation instruction, and verifies no grants,
reminders or scheduler calls. It does not load a production scheduler or send QQ.
Both proposal scenarios accept `natural-a` / `natural-b` as a third argument:
fixed ordinary requests without tool names, call-count or confirmation-format hints.
Proposal turns permit up to three calls only when preceding failures are Host
schema rejections with corrected arguments. Identical rejected arguments,
business rejections, unmatched/unknown responses and multiple successes fail.
`call-analysis.mjs` records these separately using call IDs (legacy reports require
one unambiguous pending call). It does not infer writes from success responses:
pending proposal counts, grants, domain facts and repeat-confirmation snapshots
are checked separately. Negative and Search scenarios retain strict one-call checks.
Original failed reports are retained, never relabeled by the new classifier.
Proposal reports also compare the real SQLite ID/hash with both tool output and
the delivered confirmation phrase: two identically redacted strings are not a
passing reference. Single-call proposal finals must equal the backend preview.
An isolated read-only observer records after-tool/final run and session IDs for
delivery correlation; it does not modify payloads or run as a production plugin.
Production `controlled-replies` handles only eligible single-success final
proposal replies, leaving mixed calls, errors, prior blocks and media untouched.
`search` uses the current DeepSeek
service and a temporary observer to check unchanged source URLs without disabling
persistence redaction. `search-error` reuses the actual plugin/provider/parser
with fixed invalid transport output and does not call DeepSeek.
It reads the current primary provider and its environment credential (preferring
`gateway.systemd.env`), and copies AGENTS/SOUL/TOOLS when present into an isolated
workspace. These prompts and synthetic messages are sent to the configured
model; the owner explicitly authorized this on 2026-09-10. No QQ transport,
plugin services, or Reminder scheduler is started. Reports omit thinking blocks.
Unlike the earlier drivers, its default parent is `state/acceptance` under
`KURUMI_SOURCE_ROOT`; each invocation creates a fresh `agent-errors-*` directory.

None of these tests proves QQ network transport or QQ identity verification.
`run-real-cron.mjs` starts a separate token-authenticated loopback Gateway with
plugins disabled and isolated storage, then checks real Cron add/update/remove
using production parameter builders, domain transactions and synthetic
confirmation hooks. It schedules one day ahead and cancels before shutdown;
it does not run the delivery CLI or send QQ messages. The child Gateway is
stopped in `finally`; reports and databases are retained for inspection.
`run-search-provider.mjs` observes one public query through the actual provider,
parser and quota, using the same trusted endpoint SDK without the main Agent.
Its test transport observer replaces the default HTTP wrapper and saves shape
and normalized output, not raw thinking or keys.
The older `model-driver.mjs` still uses a bounded custom tool loop and must not
be confused with the default-agent tests. Never weaken production authorization
to make synthetic events pass. Stage outcomes and remaining boundaries are kept
in `docs/verification/2026-09-10_文档与现状复核.txt`.

Profile GeoAPI regression (D22): `probe-profile-geo.py` performs authorized read-only provider comparisons and decodes gzip; it never emits keys/raw response bodies. `run-profile-geo.mjs` uses the actual guarded client and an isolated domain database to verify request rejection, ambiguity and pending-only success. `run-agent-errors.mjs profile-geo` checks a single explicitly specified rejected request through the default Agent and buffered reply dispatcher; this is not a natural-language reliability test or QQ network delivery. All real-location runs require the owner's external-location authorization (granted in this session).
