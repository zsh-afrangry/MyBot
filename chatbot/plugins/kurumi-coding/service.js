// Task orchestration. Execution, Git, confirmation and outward transport each keep their own boundaries.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AcpClient, processIdentity, sameProcess, descendants} from '../../packages/coding-runtime/acp-client.js';
import {inspectOwnedRuntime, stopOwnedRuntime} from '../../packages/coding-runtime/reconciliation.js';
import {probeWriteFence, confinedProcess} from '../../packages/coding-runtime/write-fence.js';
import {CodingStore} from './store.js';
import {PermissionAudit} from './permissions.js';
import {CodingResultRecorder, readCodingResult, completionText} from './results.js';
import {projectPolicy, createWorkspace, assertTaskLocation, assertCandidateLocation, assertWorkspace, runChecks, commitUnit, snapshot, targetState, git, workingHash, assertDirtyPreserved, rollbackUnit, executionEnv, assertNoUntrackedOverwrite} from './workspaces.js';
import {digest, fail, taskText} from './policy.js';
import {directoryState, directoryPlan, prepareDirectoryWriteback, runDirectoryWriteback, directoryWritebackState} from './directory-workspaces.js';

export class CodingService {
  constructor(config, {authorize, sendText, trace = () => {}, clientFactory = args => new AcpClient(args)} = {}) {
    this.config = config; this.authorize = authorize; this.sendText = sendText; this.trace = trace;
    this.clientFactory = clientFactory; this.active = new Map(); this.projectLocks = new Set(); this.started = false;
  }
  start() {
    if (this.started) return;
    projectPolicy(this.config);
    this.boundaryFacts = probeWriteFence(this.config.writeBoundary);
    fs.mkdirSync(this.config.root, {recursive: true, mode: 0o700});
    this.lockFile = path.join(this.config.root, 'service.lock');
    if (fs.existsSync(this.lockFile)) {
      const owner = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      if (sameProcess(owner)) throw fail('coding_service_already_running');
      fs.unlinkSync(this.lockFile);
    }
    fs.writeFileSync(this.lockFile, JSON.stringify(processIdentity(process.pid)), {flag: 'wx', mode: 0o600});
    try {
      this.store = new CodingStore(this.config.root);
      for (const task of this.store.list()) if (['queued', 'running', 'checking', 'cancelling', 'merging'].includes(task.state)) {
        this.store.save({...task, state: 'needs_reconciliation', reason: 'restart_requires_state_check', stateBeforeReconciliation: task.state});
        const round = task.executionRoundId && this.store.result(task.id, task.executionRoundId);
        if (round) this.store.saveResult(task.id, {...round, state: 'needs_reconciliation', reason: 'restart_requires_state_check', interruptedAt: new Date().toISOString()});
      }
      this.started = true;
    } catch (error) { fs.unlinkSync(this.lockFile); throw error; }
  }
  project(id) { const p = this.config.projects.find(p => p.id === id); if (!p) throw fail('unknown_coding_project'); return p; }
  target(project) { return project.kind === 'directory' ? {kind: 'directory', files: directoryState(project.root)} : targetState(project); }
  task(id, requester) {
    const task = this.store.get(id);
    if (!task || task.requester.subjectId !== requester.subjectId || task.requester.sessionKey !== requester.sessionKey) throw fail('unknown_coding_task');
    this.authorize(task.requester, 'tasks.read');
    assertTaskLocation(this.config, this.project(task.projectId), task);
    return task;
  }
  event(task, kind, data = {}) {
    this.trace({source: 'coding', kind, correlation: {...task.correlation, taskId: task.id},
      data: {projectId: task.projectId, backend: 'dsh-acp', state: task.state, ...(task.externalSessionId ? {externalSessionId: task.externalSessionId} : {}), ...data}});
  }
  describe(task) {
    const {id, state, projectId, base, branch, cwd, externalSessionId, verifiedCommit, checks, mergeChecks, reason, delivery, candidate, permissionSummary, executionBoundary, executionRoundId, reconciliation, workspaceKind} = task;
    return {id, state, projectId, base, branch, cwd, backend: 'dsh-acp', externalSessionId, verifiedCommit, checks, mergeChecks, reason, delivery, candidate, permissionSummary, executionBoundary, executionRoundId, reconciliation, workspaceKind: workspaceKind ?? 'git'};
  }
  list(requester) { this.authorize(requester, 'tasks.read'); return this.store.list().filter(t => t.requester.subjectId === requester.subjectId && t.requester.sessionKey === requester.sessionKey).map(t => this.describe(t)); }
  status(id, requester) { return this.describe(this.task(id, requester)); }
  result(id, requester, options) {
    const task = this.task(id, requester);
    return {task: this.describe(task), result: readCodingResult(this.store, task, options)};
  }
  submit({projectId, task: text}, {requester, key, correlation}) {
    this.authorize(requester, 'tasks.code');
    taskText(text);
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw fail('missing_coding_request_key');
    const project = this.project(projectId), requestHash = digest(JSON.stringify({projectId, text, requester}));
    const old = this.store.find(key);
    if (old) { if (old.requestHash !== requestHash) throw fail('coding_request_key_conflict'); return this.describe(this.task(old.id, requester)); }
    const id = randomUUID();
    const workspace = createWorkspace(this.config, project, id);
    const task = {id, projectId, text, requestKey: key, requestHash, requester, correlation, createdAt: Date.now(), state: 'queued', ...workspace};
    this.store.create(task); this.event(task, 'coding.submitted');
    this.launch(task, text); return this.describe(this.store.get(id));
  }
  launch(task, text) {
    if (this.active.has(task.id)) throw fail('coding_task_busy');
    const entry = {controller: new AbortController(), roundId: randomUUID()};
    this.store.createResult(task, {roundId: entry.roundId, state: 'queued', startedAt: new Date().toISOString(), baseCommit: task.verifiedCommit});
    this.active.set(task.id, entry);
    entry.monitor = setInterval(() => {
      try {this.authorize(task.requester, 'tasks.code');}
      catch {this.requestStop(entry, 'authorization_revoked');}
      try {
        if (sameProcess(entry.client?.identity)) {
          const current = this.store.get(task.id);
          this.store.save({...current, runtimeProcesses: descendants(entry.client.identity.pid).filter(sameProcess)});
        }
      } catch { /* Missing process facts remain explicitly unverified after restart. */ }
    }, 1000); entry.monitor.unref();
    entry.done = this.execute(task.id, text, entry).catch(error => {
      const current = this.store.get(task.id);
      this.store.save({...current, state: 'failed', reason: error.code ?? 'coding_execution_failed'});
      this.finishResult(this.store.get(task.id));
      this.event(this.store.get(task.id), 'coding.failed', {code: error.code ?? 'coding_execution_failed'});
      return this.notify(this.store.get(task.id));
    }).finally(() => {clearInterval(entry.monitor); this.active.delete(task.id);});
  }
  async execute(id, text, entry) {
    let task = this.store.get(id), denied = false;
    const project = this.project(task.projectId), directory = path.join(this.config.root, 'tasks', id);
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    const patch = path.join(directory, 'acp.patch.yml');
    const backendRoot = path.join(this.config.root, 'backend'), backendHome = path.join(backendRoot, 'dsh-home');
    fs.mkdirSync(backendHome, {recursive: true, mode: 0o700});
    fs.writeFileSync(patch, `- id: session-title-llm\n  disabled: true\n- id: credentials\n  config:\n    path: ${JSON.stringify(path.join(this.config.dsh.home, '.credentials.yaml'))}\n    watch: false\n- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(path.join(backendRoot, 'sessions'))}\n- id: storage-json\n  config:\n    root: ${JSON.stringify(path.join(backendRoot, 'storages'))}\n- id: attachment-local\n  config:\n    dshHome: ${JSON.stringify(backendRoot)}\n`, {mode: 0o600});
    const update = changes => { task = {...this.store.get(id), ...changes}; this.store.save(task); };
    this.authorize(task.requester, 'tasks.code'); assertTaskLocation(this.config, project, task); assertWorkspace(task); entry.controller.signal.throwIfAborted();
    const audit = new PermissionAudit(directory, task, this.config.writeBoundary), roundId = entry.roundId;
    update({state: 'running', reason: undefined, permissionSummary: audit.summary(), executionBoundary: this.boundaryFacts}); this.event(task, 'coding.running');
    const dsh = this.config.dsh;
    const confined = confinedProcess(this.config.writeBoundary, dsh.command, ['--profile', 'acp', '--patch', patch], task.cwd);
    const client = this.clientFactory({command: confined.command, args: confined.args, cwd: task.cwd,
      env: {...executionEnv(), ...confined.env, DSH_HOME: backendHome, DSH_PERMISSION_MODE: 'workspace-write', DSH_TOOLS_MODE: 'native'},
      stderrFile: path.join(directory, 'acp.stderr'), permission: async (params, call, context) => {
        denied = true;
        const result = audit.reject(params, call, context, roundId);
        update({permissionSummary: result.summary});
        if (!result.duplicate) this.event(task, 'coding.permission_rejected', {decisionSource: 'owner_test_folder_only',
          externalToolCallId: call?.toolCallId, requests: result.summary.requests, rejected: result.summary.rejected});
        return false;
      }});
    entry.client = client; update({runtimeIdentity: client.identity});
    try {
      await client.initialize(); entry.controller.signal.throwIfAborted();
      if (sameProcess(client.identity)) update({runtimeIdentity: processIdentity(client.identity.pid), runtimeProcesses: descendants(client.identity.pid).filter(sameProcess)});
      const externalSessionId = await client.open(task.cwd, {sessionId: task.externalSessionId, model: dsh.model});
      update({externalSessionId}); entry.controller.signal.throwIfAborted(); this.event(task, 'coding.session_bound');
      const round = this.store.result(id, roundId);
      this.store.saveResult(id, {...round, state: 'running', externalSessionId});
      const recorder = new CodingResultRecorder(this.store, id, roundId, externalSessionId);
      client.on('notification', frame => {
        if (frame.method !== 'session/update' || frame.params?.sessionId !== externalSessionId) return;
        recorder.capture(frame);
        const update = frame.params.update;
        if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) this.event(task, 'coding.tool_event', {eventType: update.sessionUpdate, externalToolCallId: update.toolCallId});
      });
      const instruction = `Work only on the authorized task in ${task.cwd}. Read applicable AGENTS.md. Do not commit, merge, push, edit other worktrees, change services, or install system software. The host runs registered checks and creates verified commits. Keep unfinished work in this worktree. Task:\n${text}`;
      const result = await client.prompt(instruction);
      this.store.saveResult(id, {...this.store.result(id, roundId), stopReason: result.stopReason});
      if (entry.cancelRequested || result.stopReason === 'cancelled') {
        const stopped = await client.cancellationStopped();
        update({state: stopped ? 'cancelled' : 'needs_reconciliation', reason: stopped ? entry.cancelReason : 'cancel_not_verified'});
        this.event(task, 'coding.cancelled', {stopped}); return;
      }
      await client.request('session/close', {sessionId: externalSessionId}); await client.stop();
      if (denied) { update({state: 'needs_permission', reason: 'extra_backend_permission_required'}); this.event(task, 'coding.needs_permission'); await this.notify(task); return; }
      if (result.stopReason !== 'end_turn') throw fail('coding_turn_incomplete');
      this.authorize(task.requester, 'tasks.code'); assertWorkspace(task);
      update({state: 'checking', runtimeIdentity: undefined, runtimeProcesses: undefined}); this.event(task, 'coding.checking');
      const snapshotPath = snapshot(task, path.join(directory, 'snapshots', randomUUID()));
      update({snapshotPath});
      const checkedHash = workingHash(task.cwd), checkPlan = structuredClone(project.checks);
      const checks = await runChecks({...project, checks: checkPlan}, task.cwd, path.join(directory, 'checks.log'), entry.controller.signal, this.config.writeBoundary,
        runtime => update({runtimeIdentity: runtime?.identity, runtimeProcesses: runtime?.processes}));
      assertTaskLocation(this.config, this.project(task.projectId), task);
      if (JSON.stringify(this.project(task.projectId).checks) !== JSON.stringify(checkPlan)) throw fail('checks_changed_during_validation');
      if (workingHash(task.cwd) !== checkedHash) throw fail('checked_tree_changed');
      update({checks}); this.event(task, 'coding.checked', {ok: checks.ok, checkCount: checks.rows.length});
      if (!checks.ok) { update({state: 'check_failed', reason: 'registered_checks_failed'}); await this.notify(task); return; }
      this.authorize(task.requester, 'tasks.code'); entry.controller.signal.throwIfAborted();
      const verifiedCommit = commitUnit(task, checkedHash);
      update({verifiedCommit, state: 'ready', runtimeIdentity: undefined, runtimeProcesses: undefined}); this.event(task, 'coding.ready', {verifiedCommit});
      await this.notify(task);
    } catch (error) {
      if (entry.cancelRequested) {
        try { client.cancel(); } catch { /* Connection may already be closed. */ }
        const runtimeStopped = await client.cancellationStopped();
        const stopped = runtimeStopped && error.code !== 'check_cancel_not_verified';
        update({state: stopped ? 'cancelled' : 'needs_reconciliation', reason: stopped ? entry.cancelReason : 'cancel_not_verified'});
        this.event(task, 'coding.cancelled', {stopped}); return;
      }
      throw error;
    } finally { await client.stop(); this.finishResult(this.store.get(id)); }
  }
  continue(id, text, requester, key) {
    const task = this.task(id, requester); this.authorize(requester, 'tasks.code');
    taskText(text);
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw fail('missing_coding_request_key');
    const hash = digest(JSON.stringify({id, text, requester}));
    const old = this.store.findCommand(key);
    if (old) { if (old.task_id !== id || old.hash !== hash) throw fail('coding_request_key_conflict'); return this.describe(task); }
    if (task.state === 'needs_reconciliation' && task.mergeProposalId) throw fail('merge_reconciliation_required');
    if (!['ready', 'check_failed', 'failed', 'cancelled', 'needs_permission', 'needs_reconciliation', 'interrupted', 'rolled_back'].includes(task.state) || this.active.has(id)) throw fail('coding_task_busy');
    const runtime = inspectOwnedRuntime(task.runtimeIdentity, task.runtimeProcesses, task.cwd);
    if (!runtime.verified) throw fail('runtime_reconciliation_unverified');
    if (!runtime.stopped) throw fail('original_runtime_still_running');
    assertWorkspace(task); this.store.command(key, id, hash); this.store.invalidate(id); this.launch(task, text); return this.describe(this.store.get(id));
  }
  async cancel(id, requester) {
    const task = this.task(id, requester); this.authorize(requester, 'tasks.code');
    const entry = this.active.get(id);
    if (!entry) {
      if (['cancelled', 'merged', 'written_back'].includes(task.state)) return this.describe(task);
      if (task.state === 'needs_reconciliation' && task.mergeProposalId) throw fail('merge_reconciliation_required');
      const runtime = await stopOwnedRuntime(task.runtimeIdentity, task.runtimeProcesses, task.cwd);
      if (!runtime.verified || !runtime.stopped) throw fail(runtime.reason ?? 'cancel_requires_runtime_reconciliation');
      this.store.invalidate(id); this.store.save({...task, state: 'cancelled', runtimeIdentity: undefined, runtimeProcesses: undefined});
      this.finishResult(this.store.get(id)); this.event(this.store.get(id), 'coding.cancelled', {stopped: true});
      return this.describe(this.store.get(id));
    }
    this.requestStop(entry); this.store.save({...task, state: 'cancelling'}); this.event(this.store.get(id), 'coding.cancel_requested');
    await entry.done;
    return this.describe(this.store.get(id));
  }
  rollback(id, requester) {
    const task = this.task(id, requester); this.authorize(requester, 'tasks.code');
    if (this.active.has(id) || !['check_failed', 'failed', 'cancelled', 'needs_permission', 'interrupted'].includes(task.state)) throw fail('coding_task_busy');
    const runtime = inspectOwnedRuntime(task.runtimeIdentity, task.runtimeProcesses, task.cwd);
    if (!runtime.verified || !runtime.stopped) throw fail('runtime_reconciliation_unverified');
    const snapshotPath = snapshot(task, path.join(this.config.root, 'tasks', id, 'snapshots', randomUUID()));
    rollbackUnit(task); this.store.invalidate(id);
    this.store.save({...task, state: 'rolled_back', snapshotPath, reason: undefined});
    this.event(this.store.get(id), 'coding.rolled_back'); return this.describe(this.store.get(id));
  }
  reconcile(id, requester) {
    const task = this.task(id, requester); this.authorize(requester, 'tasks.code');
    if (this.active.has(id)) throw fail('coding_task_busy');
    if (task.state !== 'needs_reconciliation') return this.describe(task);
    const observed = inspectOwnedRuntime(task.runtimeIdentity, task.runtimeProcesses, task.cwd);
    const reconciliation = {at: new Date().toISOString(), verified: observed.verified, stopped: observed.stopped,
      processCount: observed.processes.length, ...(observed.reason ? {reason: observed.reason} : {})};
    let changes = {reconciliation};
    if (observed.verified && observed.stopped) {
      assertWorkspace(task);
      if (task.stateBeforeReconciliation === 'merging' || task.reason === 'merge_result_requires_check') {
        const preview = this.store.getPreview(task.mergeProposalId), project = this.project(task.projectId), target = this.target(project);
        if (!preview || preview.payload.candidate !== task.mergeCandidate) throw fail('merge_reconciliation_unverified');
        if (project.kind === 'directory') {
          const transaction = task.directoryWriteback;
          if (transaction && (path.dirname(path.dirname(transaction.file)) !== path.join(this.config.root, 'tasks', id)
            || !/^writeback-[a-f0-9-]{36}$/.test(path.basename(path.dirname(transaction.file))) || path.basename(transaction.file) !== 'journal.json')) throw fail('invalid_directory_writeback');
          const state = transaction ? directoryWritebackState(transaction, project)
            : JSON.stringify(target) === JSON.stringify(preview.payload.target) ? 'ready' : undefined;
          if (!state) throw fail('directory_writeback_requires_reconciliation');
          changes = {...changes, state, reason: state === 'ready' ? 'writeback_not_applied_preview_again' : undefined, candidate: state === 'ready' ? undefined : task.candidate};
        } else if (target.branch !== project.branch) throw fail('merge_reconciliation_unverified');
        else if (target.head === preview.payload.candidate) {
          assertDirtyPreserved(project, preview.payload.target);
          if (target.status !== preview.payload.target.status || target.diff !== preview.payload.target.diff) throw fail('merge_reconciliation_unverified');
          changes = {...changes, state: 'merged', mergeCommit: target.head, reason: undefined};
        } else if (JSON.stringify(target) === JSON.stringify(preview.payload.target)) {
          changes = {...changes, state: 'ready', reason: 'merge_not_applied_preview_again', candidate: undefined};
        } else throw fail('merge_reconciliation_unverified');
      } else {
        const snapshotPath = snapshot(task, path.join(this.config.root, 'tasks', id, 'snapshots', randomUUID()));
        changes = {...changes, state: 'interrupted', reason: 'execution_stopped_no_replay', snapshotPath};
      }
      changes = {...changes, runtimeIdentity: undefined, runtimeProcesses: undefined};
      this.store.invalidate(id);
    }
    this.store.save({...task, ...changes}); this.finishResult(this.store.get(id));
    this.event(this.store.get(id), 'coding.reconciled', {verified: observed.verified, stopped: observed.stopped});
    return this.describe(this.store.get(id));
  }
  diff(id, requester) {
    const task = this.task(id, requester); assertWorkspace(task);
    return {task: this.describe(task), diff: git(task.cwd, 'diff', '--no-ext-diff', task.base, '--'), committedDiff: git(task.cwd, 'diff', '--no-ext-diff', task.base, task.verifiedCommit, '--')};
  }
  async preview(id, requester, scope) {
    const task = this.task(id, requester); this.authorize(requester, 'tasks.code');
    if (task.state !== 'ready' || this.active.has(id)) throw fail('coding_task_not_ready');
    assertWorkspace(task);
    if (git(task.cwd, 'status', '--porcelain=v1').trim()) throw fail('task_has_unverified_changes');
    const project = structuredClone(this.project(task.projectId));
    if (this.projectLocks.has(project.id)) throw fail('project_merge_busy');
    this.projectLocks.add(project.id);
    try {
      const directory = project.kind === 'directory', target = this.target(project);
      if (!directory && target.branch !== project.branch) throw fail('target_branch_changed');
      if (directory && JSON.stringify(target.files) !== JSON.stringify(task.directoryBaseline)) throw fail('directory_source_changed');
      const candidateDir = path.join(this.config.worktrees, `candidate-${randomUUID()}`);
      const commits = git(task.cwd, 'rev-list', '--reverse', `${task.base}..${task.verifiedCommit}`).trim().split('\n').filter(Boolean);
      if (!commits.length) throw fail('no_coding_changes');
      if (directory) {
        git(task.cwd, 'worktree', 'add', '--detach', candidateDir, task.verifiedCommit);
        for (const row of task.directoryBaseline) if (row.kind === 'directory' && !fs.existsSync(path.join(candidateDir, row.name))) fs.mkdirSync(path.join(candidateDir, row.name), {recursive: true, mode: row.mode});
      } else {
        git(project.root, 'worktree', 'add', '--detach', candidateDir, target.head);
        try {git(candidateDir, '-c', 'user.name=Kurumi', '-c', 'user.email=kurumi@localhost', 'cherry-pick', ...commits);}
        catch {throw fail('merge_conflict');}
      }
      const checkedHash = workingHash(candidateDir), checkPlan = structuredClone(project.checks);
      const checks = await runChecks({...project, checks: checkPlan}, candidateDir, path.join(this.config.root, 'tasks', id, 'candidate-checks.log'), undefined, this.config.writeBoundary);
      if (!checks.ok) throw fail('candidate_checks_failed');
      this.task(id, requester); this.authorize(requester, 'tasks.code');
      if (this.active.has(id) || this.store.get(id).verifiedCommit !== task.verifiedCommit || this.store.get(id).state !== 'ready') throw fail('coding_task_not_ready');
      if (this.project(task.projectId).root !== project.root || this.project(task.projectId).branch !== project.branch || this.project(task.projectId).kind !== project.kind
        || JSON.stringify(this.project(task.projectId).checks) !== JSON.stringify(checkPlan)) throw fail('checks_changed_during_validation');
      if (workingHash(candidateDir) !== checkedHash) throw fail('checked_candidate_changed');
      if (JSON.stringify(this.target(project)) !== JSON.stringify(target)) throw fail('target_changed_during_checks');
      const candidate = git(candidateDir, 'rev-parse', 'HEAD').trim();
      const diffBase = directory ? task.base : target.head;
      const diff = git(candidateDir, 'diff', '--no-ext-diff', diffBase, candidate, '--');
      if (!directory) assertNoUntrackedOverwrite(project, target.head, candidate);
      const plan = directory ? directoryPlan(project, task, candidateDir, git) : undefined;
      const paths = directory ? plan.changes.map(c => c.name) : git(candidateDir, 'diff', '--name-only', target.head, candidate, '--').trim().split('\n');
      const payload = {taskId: id, projectId: project.id, projectRoot: project.root, taskCommit: task.verifiedCommit, target, candidate, diffBase,
        diffHash: digest(diff), candidateDir, checks, ...(directory ? {directoryPlan: plan} : {})};
      const previewText = `${directory ? '实验目录待确认回写' : '编码任务待确认合入'}\n项目：${project.id}\n任务：${id}\n任务提交：${task.verifiedCommit}\n目标：${directory ? project.root : project.branch + ' @ ' + target.head}\n候选：${candidate}\n变更文件：${paths.join('、')}\n检查：${checks.rows.map(r => r.name + (r.skipped ? '=不适用' : '=通过')).join('；')}\n${directory ? '原目录基线一致，回写前再次核对；原目录不建立Git。' : '目标当前有未提交内容：' + (target.status ? '有，合入不得覆盖' : '无')}\n差异SHA256：${payload.diffHash}\n请审阅差异后确认${directory ? '目录回写' : '本地合入'}；不包含push。`;
      const result = this.store.preview(task, payload, previewText, scope);
      this.store.save({...task, candidate}); this.event(task, 'coding.merge_preview', {candidate, proposalId: result.proposalId, payloadHash: result.payloadHash});
      return result;
    } finally { this.projectLocks.delete(project.id); }
  }
  async merge(id, proposalId, requester, scope, assertCurrent) {
    const task = this.task(id, requester), project = structuredClone(this.project(task.projectId));
    this.authorize(requester, 'tasks.code'); assertCurrent();
    if (this.active.has(id) || this.projectLocks.has(project.id)) throw fail('project_merge_busy');
    this.projectLocks.add(project.id);
    try {
      const preview = this.store.getPreview(proposalId);
      if (!preview || preview.taskId !== id || task.state !== 'ready' || preview.payload.taskCommit !== task.verifiedCommit) throw fail('merge_not_pending');
      const directory = project.kind === 'directory';
      if (preview.payload.projectRoot !== project.root || (directory ? !preview.payload.directoryPlan : preview.payload.target.branch !== project.branch)) throw fail('merge_preview_stale');
      assertWorkspace(task);
      if (git(task.cwd, 'status', '--porcelain=v1').trim()) throw fail('task_has_unverified_changes');
      if (JSON.stringify(this.target(project)) !== JSON.stringify(preview.payload.target)) { this.store.invalidate(id); throw fail('merge_preview_stale'); }
      const assertCandidate = () => {
        assertCandidateLocation(this.config, this.project(task.projectId), preview.payload.candidateDir, task);
        if (git(preview.payload.candidateDir, 'rev-parse', 'HEAD').trim() !== preview.payload.candidate
          || git(preview.payload.candidateDir, 'status', '--porcelain=v1').trim()
          || digest(git(preview.payload.candidateDir, 'diff', '--no-ext-diff', preview.payload.diffBase ?? preview.payload.target.head, preview.payload.candidate, '--')) !== preview.payload.diffHash) throw fail('candidate_changed');
      };
      assertCandidate();
      const checkPlan = structuredClone(project.checks), checkedHash = workingHash(preview.payload.candidateDir);
      const checks = await runChecks({...project, checks: checkPlan}, preview.payload.candidateDir,
        path.join(this.config.root, 'tasks', id, 'merge-checks.log'), undefined, this.config.writeBoundary);
      const current = this.task(id, requester); this.authorize(requester, 'tasks.code'); assertCurrent();
      if (current.state !== 'ready' || current.verifiedCommit !== task.verifiedCommit || this.active.has(id)) throw fail('merge_preview_stale');
      if (this.project(task.projectId).root !== project.root || this.project(task.projectId).branch !== project.branch || this.project(task.projectId).kind !== project.kind
        || JSON.stringify(this.project(task.projectId).checks) !== JSON.stringify(checkPlan)) throw fail('checks_changed_during_validation');
      assertWorkspace(current); assertCandidate();
      if (workingHash(preview.payload.candidateDir) !== checkedHash) throw fail('checked_candidate_changed');
      if (JSON.stringify(this.target(project)) !== JSON.stringify(preview.payload.target)) { this.store.invalidate(id); throw fail('merge_preview_stale'); }
      this.store.save({...current, mergeChecks: {...checks, candidate: preview.payload.candidate, at: new Date().toISOString()}});
      this.event(this.store.get(id), 'coding.merge_checked', {ok: checks.ok, checkCount: checks.rows.length});
      if (!checks.ok) throw fail('candidate_checks_failed');
      if (directory) {
        if (JSON.stringify(directoryPlan(project, task, preview.payload.candidateDir, git)) !== JSON.stringify(preview.payload.directoryPlan)) throw fail('candidate_changed');
      } else assertNoUntrackedOverwrite(project, preview.payload.target.head, preview.payload.candidate);
      assertCurrent(); const payload = this.store.claimMerge(task, proposalId, scope);
      this.event(this.store.get(id), 'coding.merge_authorized', {proposalId});
      try {
        if (directory) {
          const transaction = prepareDirectoryWriteback(this.config.root, project, task, payload.candidateDir, payload.directoryPlan);
          this.store.save({...this.store.get(id), directoryWriteback: transaction});
          runDirectoryWriteback(this.config.writeBoundary, project, transaction);
        } else {
          git(project.root, 'merge', '--ff-only', payload.candidate);
          if (git(project.root, 'rev-parse', 'HEAD').trim() !== payload.candidate || git(project.root, 'symbolic-ref', '--short', 'HEAD').trim() !== project.branch) throw fail('merge_result_requires_check');
          assertDirtyPreserved(project, payload.target);
        }
      } catch {
        this.store.save({...this.store.get(id), state: 'needs_reconciliation', reason: 'merge_result_requires_check'});
        throw fail('merge_result_requires_check');
      }
      this.store.save({...this.store.get(id), state: directory ? 'written_back' : 'merged', mergeCommit: directory ? undefined : payload.candidate, reason: undefined});
      this.event(this.store.get(id), directory ? 'coding.written_back' : 'coding.merged', {candidate: payload.candidate});
      return this.describe(this.store.get(id));
    } finally { this.projectLocks.delete(project.id); }
  }
  async notify(task) {
    if (!this.sendText) return;
    // A prior completion callback must never deliver a later round or retry an uncertain send.
    const current = this.store.get(task.id);
    if (current.executionRoundId !== task.executionRoundId || current.state !== task.state) return;
    task = current;
    const key = `coding:${task.id}:${task.executionRoundId ?? task.verifiedCommit}:${task.state}`;
    if (task.delivery?.key === key) return;
    try {
      this.authorize(task.requester, 'tasks.read');
      this.authorize(task.requester, 'qq.reply');
      task = this.task(task.id, task.requester);
      this.finishResult(task);
      let result = readCodingResult(this.store, task, {limit: 1800});
      if (result.available && result.page.nextOffset !== null) result = readCodingResult(this.store, task, {offset: Math.max(0, result.page.totalChars - 1800), limit: 1800});
      const text = completionText(task, result), bodyHash = digest(text);
      if (result.available) this.store.saveResult(task.id, {...this.store.result(task.id, result.roundId), notification: {key, text, bodyHash}});
      this.store.save({...this.store.get(task.id), delivery: {state: 'sending', key, roundId: task.executionRoundId, bodyHash}});
      const receipt = await this.sendText({to: task.requester.to, text, key});
      if (receipt?.channel !== 'kurumi-qq' || typeof receipt.messageId !== 'string' || !/^-?[1-9][0-9]*$/.test(receipt.messageId)) throw fail('missing_delivery_receipt');
      this.store.save({...this.store.get(task.id), delivery: {...this.store.get(task.id).delivery, state: 'platform_accepted', messageId: receipt.messageId}});
      this.event(this.store.get(task.id), 'coding.delivery', {state: 'platform_accepted'});
    } catch (e) {
      this.store.save({...this.store.get(task.id), delivery: {...this.store.get(task.id).delivery, key, roundId: task.executionRoundId, state: 'unknown', code: e.code ?? 'delivery_failed'}});
      this.event(this.store.get(task.id), 'coding.delivery', {state: 'unknown'});
    }
  }
  finishResult(task) {
    if (!task.executionRoundId) return;
    const round = this.store.result(task.id, task.executionRoundId);
    if (!round) return;
    let changedFiles = round.changedFiles;
    try {
      changedFiles = [...new Set([...git(task.cwd, 'diff', '--name-only', '-z', round.baseCommit, '--').split('\0'),
        ...git(task.cwd, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean))].sort();
    } catch { /* Failed or interrupted workspace; no invented artifact claim. */ }
    this.store.saveResult(task.id, {...round, state: task.state, reason: task.reason, hostChecks: task.checks, changedFiles,
      verifiedCommit: task.verifiedCommit, finishedAt: round.finishedAt ?? new Date().toISOString()});
  }
  requestStop(entry, reason) {
    entry.cancelRequested = true; if (reason) entry.cancelReason = reason; entry.controller.abort();
    try {entry.client?.cancel();} catch {}
    // Do not wait forever for session/prompt to acknowledge cancellation. Closing
    // this owned stdio process also rejects the pending prompt and verifies its tree.
    if (entry.client) entry.stopping ??= entry.client.cancellationStopped().catch(() => false);
  }
  async idle(id) { await this.active.get(id)?.done; }
  async stop() {
    if (!this.started) return;
    await Promise.all([...this.active.entries()].map(async ([id, entry]) => {
      this.requestStop(entry);
      await entry.done;
    }));
    this.store.close(); this.started = false;
    if (fs.existsSync(this.lockFile)) {
      const owner = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      if (owner.pid === process.pid && sameProcess(owner)) fs.unlinkSync(this.lockFile);
    }
  }
}
