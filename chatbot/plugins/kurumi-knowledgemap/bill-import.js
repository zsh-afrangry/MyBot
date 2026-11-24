import fs from 'node:fs';
import path from 'node:path';
import {scopeFromToolContext} from '../../packages/confirmation-core/dist/index.js';
import {businessFeedback} from '../../packages/feedback-core/index.js';
import {BridgeError} from '../../packages/knowledgemap-client/client.js';
import {MAX_OFFICE_FILE_BYTES, OfficeReaderError, parseBillExportXlsx} from '../../packages/office-reader/index.js';
import {
  FilesError,
  buildRedlineSet,
  resolveSafePath,
  validateFilesConfig,
} from '../../packages/scoped-lease/tiers.js';
import {
  BILLS_IMPORT_DOMAIN,
  BillImportError,
  failImport,
  proposalIdPattern,
  sha256,
} from './import-store.js';
import {billFileLabel, billImportPresentation, identicalBillFiles, publicBillImportResult} from './import-presentation.js';

const MAX_IMPORT_ROWS = 5000;
const MAX_IMPORT_FILES = 8;
const IMPORT_API = '/api/assistant/bills/import';
const filePathParam = {type: 'string', maxLength: 4096, description: '受控目录内的 .xlsx 文件绝对路径'};
const sheetParam = {type: 'string', maxLength: 128, description: '可选工作表名称'};

export const billImportTool = {
  name: 'knowledge_bill_import',
  label: '从导出表格批量导入账单',
  description:
    '从已授权本地文件或 QQ/邮箱落地的账单导出 .xlsx 批量预览并导入 KnowledgeMap 账单（仅本人 QQ 私聊）。'
    + '先调用 action=preview：一份文件传 path（可选 sheet）；多份必须一次传 files 数组（每项 path 和可选 sheet，按导入顺序），生成一份提案。'
    + '将 previewText 原样展示给主人等待下一条消息；主人自然语言确认后先调用 personal_confirmation(domain="bills_import") 授权，'
    + '再调用 action=commit 传 proposalId 执行；多文件按预览顺序一次提交并逐份返回结果。结果未知时用 action=status(proposalId) 核对回执，不要另建或重复提交。action=batches 查最近批次。'
    + '给主人展示文件名和业务摘要。技术路径、哈希和提案标识只供工具使用，只有工具指出文件内容相同时才说明相同。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {type: 'string', enum: ['preview', 'commit', 'status', 'batches']},
      path: filePathParam,
      sheet: sheetParam,
      files: {
        type: 'array', minItems: 2, maxItems: MAX_IMPORT_FILES,
        description: '仅 preview，按提交顺序列出 2 至 8 份文件。与 path/sheet 互斥。',
        items: {type: 'object', additionalProperties: false, required: ['path'], properties: {path: filePathParam, sheet: sheetParam}},
      },
      proposalId: {type: 'string', pattern: '^[a-fA-F0-9-]{36}$', description: 'commit 与 status 必需的提案 ID'},
      limit: {type: 'integer', minimum: 1, maximum: 50, description: '仅 batches：最近批次数，默认 10'},
    },
  },
};

function resolveImportFile(filePath, config, stateRoot, verifyRoots) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    failImport('invalid_files_path', '请提供有效的账单 .xlsx 文件绝对路径');
  }
  const filesRaw = config?.plugins?.entries?.['kurumi-files']?.config;
  if (!filesRaw) failImport('files_not_configured', '未配置文件目录访问策略，无法读取账单文件');
  const filesCfg = validateFilesConfig(filesRaw, {stateRoot, verifyRoots});
  const redlines = buildRedlineSet(filesCfg, stateRoot);
  const resolved = resolveSafePath(filePath, filesCfg, redlines, {forWrite: false});
  if (!resolved.exists) throw new FilesError('files_not_found');
  if (!resolved.lstat?.isFile()) throw new FilesError('files_not_regular_file');
  return resolved;
}

function importInputs(args) {
  if (args.files === undefined) return [{path: args.path, sheet: args.sheet}];
  if (args.path !== undefined || args.sheet !== undefined || !Array.isArray(args.files)
    || args.files.length < 2 || args.files.length > MAX_IMPORT_FILES
    || args.files.some(file => !file || typeof file.path !== 'string'
      || Object.keys(file).some(key => !['path', 'sheet'].includes(key)))) {
    failImport('invalid_bill_import_files', '请按顺序提供 2 至 8 个文件，files 与 path/sheet 互斥');
  }
  return args.files;
}

function readImportFile(filePath, sheet, config, stateRoot, verifyRoots, expected) {
  const resolved = resolveImportFile(filePath, config, stateRoot, verifyRoots);
  if (resolved.lstat.size > MAX_OFFICE_FILE_BYTES) throw new OfficeReaderError('office_file_too_large');
  const buffer = fs.readFileSync(resolved.canonicalPath);
  const fileSha256 = sha256(buffer);
  if (expected && fileSha256 !== expected) {
    failImport('bill_import_file_changed', '账单文件在确认后已变化，请重新预览');
  }
  const parsed = parseBillExportXlsx(buffer, {sheet});
  return {
    ...parsed,
    sourcePath: resolved.canonicalPath,
    fileName: billFileLabel(path.basename(resolved.canonicalPath), fileSha256),
    fileSha256,
  };
}

function assertRowLimit(files) {
  if (files.reduce((sum, file) => sum + file.rows.length, 0) > MAX_IMPORT_ROWS) {
    failImport('bill_import_too_many_rows', '一次最多导入 ' + MAX_IMPORT_ROWS + ' 笔有效记录');
  }
}

const importBody = ({fileName, fileSha256, rows}) => ({
  file_name: fileName, file_sha256: fileSha256, rows, category_overrides: {},
});

function fileSummary(file, preview) {
  return {
    fileName: file.fileName,
    sheetName: file.sheetName,
    totalSourceRows: file.totalSourceRows,
    zeroAmountSkippedCount: file.zeroAmountSkippedCount,
    totalRows: preview.total_rows,
    insertCount: preview.insert_count,
    skippedCount: preview.skipped_count,
    totalExpense: preview.total_expense,
    totalIncome: preview.total_income,
    dateFrom: preview.date_from,
    dateTo: preview.date_to,
    plannedNewTags: preview.planned_new_tags ?? [],
    manualOverlapHintsCount: preview.manual_overlap_hints?.length ?? 0,
    manualOverlapHints: preview.manual_overlap_hints ?? [],
  };
}

const importEvidence = result => ({
  ...(result.batch_id && {batchId: result.batch_id}),
  ...(Array.isArray(result.files) && {batchIds: result.files.flatMap(file => file.batch_id ? [file.batch_id] : [])}),
  ...(result.inserted_count !== undefined && {insertedCount: result.inserted_count}),
  ...(result.skipped_count !== undefined && {skippedCount: result.skipped_count}),
});

export function isKnownImportError(error) {
  return error instanceof BridgeError
    || error instanceof BillImportError
    || error instanceof FilesError
    || error instanceof OfficeReaderError;
}

export async function executeBillImport({
  args,
  ctx,
  callId,
  signal,
  runId,
  config,
  authorized,
  forbidden,
  client,
  importStore,
  inbound,
  request,
  owner,
  stateRoot,
  verifyRoots,
  feedbackActions,
  emitTrace,
}) {
  const action = args?.action;
  if (!['preview', 'commit', 'status', 'batches'].includes(action)) {
    failImport('invalid_action', '未知账单导入动作');
  }

  if (action === 'batches') {
    const limit = args.limit ?? 10;
    const result = await client.request(IMPORT_API + '/batches', {query: {limit}, runId, signal});
    return {...result, items: result.items.map(publicBillImportResult)};
  }

  if (!importStore) failImport('bill_import_unavailable', '账单导入确认存储尚未就绪');

  if (action === 'preview') {
    const entries = importInputs(args);
    const group = entries.length > 1;
    const files = entries.map(file => readImportFile(file.path, file.sheet, config(), stateRoot, verifyRoots));
    assertRowLimit(files);
    const empty = files.every(file => file.rows.length === 0);
    const kmPreview = empty ? {
      insert_count: 0, skipped_count: 0, total_rows: 0,
      ...(group && {files: files.map(() => ({insert_count: 0, skipped_count: 0, total_rows: 0}))}),
    } : await client.request(IMPORT_API + (group ? '/group/preview' : '/preview'), {
      method: 'POST',
      body: group ? {files: files.map(importBody)} : importBody(files[0]),
      runId,
      signal,
    });
    if (!authorized()) return forbidden();
    ctx.assertInvocationCurrent();
    signal?.throwIfAborted();

    const perFile = group ? kmPreview.files : [kmPreview];
    if (!Array.isArray(perFile) || perFile.length !== files.length || !Number.isSafeInteger(kmPreview.insert_count)) {
      failImport('invalid_response', '账单预览返回的文件数量不符');
    }
    const summaries = files.map((file, i) => fileSummary(file, perFile[i]));
    const summary = group ? {
      files: summaries,
      insertCount: kmPreview.insert_count,
      skippedCount: kmPreview.skipped_count,
      totalRows: kmPreview.total_rows,
      totalExpense: kmPreview.total_expense,
      totalIncome: kmPreview.total_income,
      dateFrom: kmPreview.date_from,
      dateTo: kmPreview.date_to,
      identicalFiles: identicalBillFiles(files),
    } : summaries[0];

    if (kmPreview.insert_count === 0) {
      return {
        ok: true, status: empty ? 'empty' : 'already_imported', nothingToImport: true,
        ...(group ? {summary} : summary),
      };
    }

    const scope = scopeFromToolContext(ctx);
    if (!scope) failImport('untrusted_confirmation_context', '账单导入预览需要可信本人私聊上下文');

    const frozen = files.map(({sourcePath, fileName, fileSha256, sheetName}) =>
      ({sourcePath, fileName, fileSha256, sheetName}));
    const plan = {
      ...(group ? {kind: 'group', files: frozen} : frozen[0]),
      previewHash: kmPreview.preview_hash,
      summary,
    };
    const proposal = importStore.propose(plan, owner, scope);
    return {
      ok: true,
      status: 'needs_confirmation',
      ...proposal,
      ...billImportPresentation(files, kmPreview, group),
      summary,
    };
  }

  if (typeof args.proposalId !== 'string' || !proposalIdPattern.test(args.proposalId)) {
    failImport('invalid_proposal_id', '请提供有效的导入提案 ID');
  }

  const idempotencyKey = 'bills:import:' + args.proposalId;
  const feedbackOn = feedbackActions.has('bill.import');
  if (action === 'status') {
    const row = importStore.getProposal(args.proposalId, owner);
    const group = row.plan.kind === 'group';
    let status = row.state;
    let result = row.result;
    let code = row.error;
    let recovered = false;
    if (['executing', 'unknown'].includes(row.state)) {
      status = 'unknown';
      try {
        if (group) {
          const receipt = await client.request(IMPORT_API + '/group/receipt', {key: idempotencyKey, runId, signal});
          if (receipt.ok === true && receipt.action === 'import_group'
            && receipt.files?.length === row.plan.files.length) result = receipt;
        } else {
          const batches = await client.request(IMPORT_API + '/batches', {
            query: {request_key: idempotencyKey, limit: 1}, runId, signal,
          });
          if (batches?.ok === true && batches.items?.length === 1) result = batches.items[0];
        }
      } catch (error) {
        if (!(error instanceof BridgeError)) throw error;
        code = error.code;
      }
      if (!authorized()) return forbidden();
      ctx.assertInvocationCurrent();
      signal?.throwIfAborted();
      if (result) {
        importStore.recoverCommitted(args.proposalId, owner, result);
        status = 'committed';
        code = null;
        recovered = true;
      }
    }
    const fbStatus = {committed: 'succeeded', failed: 'failed', unknown: 'unknown'}[status];
    return {
      ok: true,
      proposalId: args.proposalId,
      status,
      ...(group ? {fileCount: row.plan.files.length} : {fileName: billFileLabel(row.source_filename, row.file_sha256)}),
      expiresAtUtc: row.expires_at_utc,
      ...(result ? {[recovered && !group ? 'batch' : 'result']: publicBillImportResult(result)} : {}),
      ...(code ? {code} : {}),
      ...(fbStatus && feedbackOn ? {feedback: businessFeedback('bill.import', fbStatus, {
        source: 'request_receipt',
        proposalId: args.proposalId,
        ...(result && importEvidence(result)),
        ...(code && {code}),
      })} : {}),
    };
  }

  // action === 'commit'
  const current = inbound.require(request, ctx, config());
  const scope = scopeFromToolContext(ctx);
  if (!scope) failImport('untrusted_confirmation_context', '账单导入提交需要可信本人确认上下文');

  const claimed = importStore.claimProposal(args.proposalId, owner, scope, ({plan}) => {
    const sources = plan.kind === 'group' ? plan.files : [plan];
    const files = sources.map(file => readImportFile(file.sourcePath, file.sheetName ?? undefined,
      config(), stateRoot, verifyRoots, file.fileSha256));
    assertRowLimit(files);
    // Keep the frozen file names in the business request, including legacy proposals.
    return files.map((file, i) => importBody({...file, fileName: sources[i].fileName}));
  });

  const {plan, verified: files} = claimed;
  const group = plan.kind === 'group';
  let result;
  try {
    result = await client.request(IMPORT_API + (group ? '/group/commit' : '/commit'), {
      method: 'POST',
      body: {
        ...(group ? {files} : files[0]),
        expected_preview_hash: plan.previewHash,
      },
      key: idempotencyKey,
      runId,
      signal,
    });
  } catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    const uncertain = error.code === 'write_result_unknown';
    const nextState = uncertain ? 'unknown' : 'failed';
    importStore.finishProposal(args.proposalId, owner, {state: nextState, code: error.code});
    const feedback = businessFeedback('bill.import', uncertain ? 'unknown' : 'failed', {
      source: 'transaction_response',
      sourceMessageId: current.messageId,
      proposalId: args.proposalId,
      code: error.code,
    });
    if (!authorized()) return forbidden();
    ctx.assertInvocationCurrent();
    signal?.throwIfAborted();
    return {
      ok: false,
      proposalId: args.proposalId,
      error: error.toJSON().error,
      ...(feedbackActions.has('bill.import') ? {feedback} : {}),
    };
  }

  importStore.finishProposal(args.proposalId, owner, {state: 'committed', result});
  try {
    emitTrace({
      source: 'trace-events',
      kind: 'bills.import.commit',
      correlation: {
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        toolCallId: callId,
        ...(runId ? {runId} : {}),
        proposalId: args.proposalId,
        requestKey: idempotencyKey,
        businessId: result.batch_id,
      },
      data: {
        outcome: 'committed',
        ...importEvidence(result),
        fileCount: files.length,
        createdTagsCount: group ? result.files.reduce((sum, file) => sum + file.created_tags.length, 0)
          : result.created_tags?.length ?? 0,
      },
    });
  } catch { /* Observation failure cannot alter committed bill batch. */ }

  if (!authorized()) return forbidden();
  ctx.assertInvocationCurrent();
  signal?.throwIfAborted();

  const feedback = businessFeedback('bill.import', 'succeeded', {
    source: 'transaction_response',
    sourceMessageId: current.messageId,
    proposalId: args.proposalId,
    ...importEvidence(result),
  });
  return {
    ...publicBillImportResult(result),
    proposalId: args.proposalId,
    ...(feedbackActions.has('bill.import') ? {feedback} : {}),
  };
}
