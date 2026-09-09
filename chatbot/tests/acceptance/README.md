# Host acceptance tests

This directory is test infrastructure, not a production plugin. Its modules
depend on production capabilities; production modules never import these tests.

Build `chatbot/packages/confirmation-core`, `chatbot/plugins/personal-confirmation`
and `chatbot/plugins/personal-weather` first, in that order. On the deployment
host, from the repository root, run:

```sh
node chatbot/tests/acceptance/run.mjs
node chatbot/tests/acceptance/run.mjs --boundaries
node chatbot/tests/acceptance/run-model.mjs
node chatbot/tests/acceptance/run-reminder-expiry.mjs
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

These tests do not prove QQ network transport, QQ identity verification, or the
full production Host agent loop. The configured model test uses a bounded test
tool loop inside the real dispatcher. Never weaken production authorization to
make synthetic events pass. Stage outcomes and remaining boundaries are kept in
`docs/7_架构偏离分析与当前卡点.txt`.
