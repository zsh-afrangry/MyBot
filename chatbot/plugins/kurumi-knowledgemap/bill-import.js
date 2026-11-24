import fs from 'node:fs';
import path from 'node:path';
import {scopeFromToolContext} from '../../packages/confirmation-core/dist/index.js';
import {businessFeedback} from '../../packages/feedback-core/index.js';
import {BridgeError} from '../../packages/knowledgemap-client/client.js';
import {OfficeReaderError, parseBillExportXlsx} from '../../packages/office-reader/index.js';
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

const MAX_IMPORT_ROWS = 5000;

export const billImportTool = {
  name: 'knowledge_bill_import',
  label: '从导出表格批量导入账单',
  description:
    '从已授权本地文件或 QQ/邮箱落地的账单导出 .xlsx 批量预览并导入 KnowledgeMap 账单（仅本人 QQ 私聊）。'
    + '先调用 action=preview 传 path（可选 sheet），返回去重统计、拟新增分类和疑似手工重叠并生成待确认提案；'
    + '将 previewText 原样展示给主人等待下一条消息；主人自然语言确认后先调用 personal_confirmation(domain="bills_import") 授权，'
    + '再调用 action=commit 传 proposalId 执行；结果未知时用 action=status(proposalId) 核对回执，不要另建或重复提交。action=batches 查最近批次。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {type: 'string', enum: ['preview', 'commit', 'status', 'batches']},
      path: {type: 'string', maxLength: 4096, description: '仅 preview：.xlsx 文件的绝对路径（须在已配置可访问目录内）'},
      sheet: {type: 'string', maxLength: 128, description: '仅 preview：可选工作表名称'},
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

function buildPresentationFacts({fileName, fileSha256, zeroAmountSkippedCount, kmPreview}) {
  const newTags = Array.isArray(kmPreview.planned_new_tags) ? kmPreview.planned_new_tags : [];
  const newCatCount = newTags.filter(t => t.type === 'category').length;
  const newSubCount = newTags.filter(t => t.type === 'subcategory').length;
  const newTagText = newTags.length === 0
    ? '无'
    : `${newTags.length} 个（大类 ${newCatCount}、子类 ${newSubCount}：`
      + newTags.slice(0, 12).map(t => (t.parent_name ? `${t.parent_name}/${t.name}` : t.name)).join('、')
      + (newTags.length > 12 ? ' 等' : '') + '）';
  const overlapCount = Array.isArray(kmPreview.manual_overlap_hints) ? kmPreview.manual_overlap_hints.length : 0;
  return [
    `账单导入预览 · ${fileName}（sha256:${fileSha256.slice(0, 12)}）`,
    `时间范围：${kmPreview.date_from} 至 ${kmPreview.date_to}`,
    `待导入：${kmPreview.insert_count} 笔（支出 ${kmPreview.total_expense} 元，收入 ${kmPreview.total_income} 元）`,
    `将跳过：重复指纹 ${kmPreview.skipped_count} 笔，0元记录 ${zeroAmountSkippedCount} 笔`,
    `拟新增分类标签：${newTagText}`,
    `疑似手工同日同额重叠：${overlapCount} 笔（仅提示，不自动合并）`,
  ];
}

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
    return await client.request('/api/assistant/bills/import/batches', {query: {limit}, runId, signal});
  }

  if (!importStore) failImport('bill_import_unavailable', '账单导入确认存储尚未就绪');

  if (action === 'preview') {
    const resolved = resolveImportFile(args.path, config(), stateRoot, verifyRoots);
    const buf = fs.readFileSync(resolved.canonicalPath);
    const fileSha256 = sha256(buf);
    const parsed = parseBillExportXlsx(buf, {sheet: args.sheet});
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      failImport('bill_import_too_many_rows', `单批最多导入 ${MAX_IMPORT_ROWS} 笔，当前共 ${parsed.rows.length} 笔`);
    }
    const fileName = path.basename(resolved.canonicalPath);
    if (parsed.rows.length === 0) {
      return {
        ok: true,
        status: 'empty',
        nothingToImport: true,
        fileName,
        totalSourceRows: parsed.totalSourceRows,
        zeroAmountSkippedCount: parsed.zeroAmountSkippedCount,
      };
    }

    const kmPreview = await client.request('/api/assistant/bills/import/preview', {
      method: 'POST',
      body: {file_name: fileName, file_sha256: fileSha256, rows: parsed.rows, category_overrides: {}},
      runId,
      signal,
    });
    if (!authorized()) return forbidden();
    ctx.assertInvocationCurrent();
    signal?.throwIfAborted();

    if (kmPreview.insert_count === 0) {
      return {
        ok: true,
        status: 'already_imported',
        nothingToImport: true,
        fileName: kmPreview.file_name,
        fileSha256,
        totalSourceRows: parsed.totalSourceRows,
        zeroAmountSkippedCount: parsed.zeroAmountSkippedCount,
        totalRows: kmPreview.total_rows,
        insertCount: 0,
        skippedCount: kmPreview.skipped_count,
        dateFrom: kmPreview.date_from,
        dateTo: kmPreview.date_to,
      };
    }

    const scope = scopeFromToolContext(ctx);
    if (!scope) failImport('untrusted_confirmation_context', '账单导入预览需要可信本人私聊上下文');

    const plan = {
      sourcePath: resolved.canonicalPath,
      fileName: kmPreview.file_name,
      sheetName: parsed.sheetName,
      fileSha256,
      previewHash: kmPreview.preview_hash,
      totalSourceRows: parsed.totalSourceRows,
      zeroAmountSkippedCount: parsed.zeroAmountSkippedCount,
      totalRows: kmPreview.total_rows,
      insertCount: kmPreview.insert_count,
      skippedCount: kmPreview.skipped_count,
      totalExpense: kmPreview.total_expense,
      totalIncome: kmPreview.total_income,
      dateFrom: kmPreview.date_from,
      dateTo: kmPreview.date_to,
      plannedNewTags: kmPreview.planned_new_tags ?? [],
      manualOverlapHints: kmPreview.manual_overlap_hints ?? [],
    };
    const proposal = importStore.propose(plan, owner, scope);
    const presentationFacts = buildPresentationFacts({
      fileName: kmPreview.file_name,
      fileSha256,
      zeroAmountSkippedCount: parsed.zeroAmountSkippedCount,
      kmPreview,
    });
    const previewText = presentationFacts.join('\n');
    return {
      ok: true,
      status: 'needs_confirmation',
      domain: BILLS_IMPORT_DOMAIN,
      proposalId: proposal.proposalId,
      payloadHash: proposal.payloadHash,
      expiresAtUtc: proposal.expiresAtUtc,
      previewText,
      presentationFacts,
      summary: {
        fileName: kmPreview.file_name,
        fileSha256,
        sheetName: parsed.sheetName,
        totalSourceRows: parsed.totalSourceRows,
        zeroAmountSkippedCount: parsed.zeroAmountSkippedCount,
        totalRows: kmPreview.total_rows,
        insertCount: kmPreview.insert_count,
        skippedCount: kmPreview.skipped_count,
        totalExpense: kmPreview.total_expense,
        totalIncome: kmPreview.total_income,
        dateFrom: kmPreview.date_from,
        dateTo: kmPreview.date_to,
        plannedNewTags: kmPreview.planned_new_tags ?? [],
        manualOverlapHintsCount: (kmPreview.manual_overlap_hints ?? []).length,
        manualOverlapHints: kmPreview.manual_overlap_hints ?? [],
      },
    };
  }

  if (typeof args.proposalId !== 'string' || !proposalIdPattern.test(args.proposalId)) {
    failImport('invalid_proposal_id', '请提供有效的导入提案 ID');
  }

  if (action === 'status') {
    const row = importStore.getProposal(args.proposalId, owner);
    const feedbackOn = feedbackActions.has('bill.import');
    if (['executing', 'unknown'].includes(row.state)) {
      let batches;
      try {
        batches = await client.request('/api/assistant/bills/import/batches', {
          query: {request_key: `bills:import:${args.proposalId}`, limit: 1},
          runId,
          signal,
        });
      } catch (error) {
        if (!(error instanceof BridgeError)) throw error;
        return {
          ok: true,
          proposalId: args.proposalId,
          status: row.state === 'executing' ? 'unknown' : row.state,
          code: error.code,
          ...(feedbackOn ? {feedback: businessFeedback('bill.import', 'unknown', {source: 'request_receipt', proposalId: args.proposalId, code: error.code})} : {}),
        };
      }
      if (batches?.ok === true && Array.isArray(batches.items) && batches.items.length === 1) {
        const batch = batches.items[0];
        importStore.recoverCommitted(args.proposalId, owner, batch);
        if (!authorized()) return forbidden();
        ctx.assertInvocationCurrent();
        signal?.throwIfAborted();
        return {
          ok: true,
          proposalId: args.proposalId,
          status: 'committed',
          batch,
          ...(feedbackOn ? {feedback: businessFeedback('bill.import', 'succeeded', {
            source: 'request_receipt',
            proposalId: args.proposalId,
            batchId: batch.batch_id,
            insertedCount: batch.inserted_count,
            skippedCount: batch.skipped_count,
          })} : {}),
        };
      }
      if (!authorized()) return forbidden();
      ctx.assertInvocationCurrent();
      signal?.throwIfAborted();
      return {
        ok: true,
        proposalId: args.proposalId,
        status: 'unknown',
        ...(feedbackOn ? {feedback: businessFeedback('bill.import', 'unknown', {source: 'request_receipt', proposalId: args.proposalId, ...(row.error && {code: row.error})})} : {}),
      };
    }

    const fbStatus = row.state === 'committed' ? 'succeeded'
      : row.state === 'failed' ? 'failed'
        : row.state === 'unknown' ? 'unknown'
          : undefined;
    return {
      ok: true,
      proposalId: args.proposalId,
      status: row.state,
      fileName: row.source_filename,
      fileSha256: row.file_sha256,
      expiresAtUtc: row.expires_at_utc,
      ...(row.result ? {result: row.result} : {}),
      ...(row.error ? {code: row.error} : {}),
      ...(fbStatus && feedbackOn ? {feedback: businessFeedback('bill.import', fbStatus, {
        source: 'request_receipt',
        proposalId: args.proposalId,
        ...(row.result?.batch_id && {batchId: row.result.batch_id}),
        ...(row.result?.inserted_count !== undefined && {insertedCount: row.result.inserted_count}),
        ...(row.result?.skipped_count !== undefined && {skippedCount: row.result.skipped_count}),
        ...(row.error && {code: row.error}),
      })} : {}),
    };
  }

  // action === 'commit'
  const current = inbound.require(request, ctx, config());
  const scope = scopeFromToolContext(ctx);
  if (!scope) failImport('untrusted_confirmation_context', '账单导入提交需要可信本人确认上下文');

  const claimed = importStore.claimProposal(args.proposalId, owner, scope, row => {
    const resolved = resolveImportFile(row.source_path, config(), stateRoot, verifyRoots);
    const buf = fs.readFileSync(resolved.canonicalPath);
    if (sha256(buf) !== row.file_sha256) {
      failImport('bill_import_file_changed', '账单文件在确认后已变化，请重新预览');
    }
    const parsed = parseBillExportXlsx(buf, {sheet: row.sheet_name ?? undefined});
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      failImport('bill_import_too_many_rows', `单批最多导入 ${MAX_IMPORT_ROWS} 笔`);
    }
    return parsed;
  });

  const {plan, verified: parsed} = claimed;
  const idempotencyKey = `bills:import:${args.proposalId}`;
  let result;
  try {
    result = await client.request('/api/assistant/bills/import/commit', {
      method: 'POST',
      body: {
        file_name: plan.fileName,
        file_sha256: plan.fileSha256,
        rows: parsed.rows,
        category_overrides: {},
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
        batchId: result.batch_id,
        fileSha256: result.file_sha256,
        insertedCount: result.inserted_count,
        skippedCount: result.skipped_count,
        createdTagsCount: Array.isArray(result.created_tags) ? result.created_tags.length : 0,
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
    batchId: result.batch_id,
    insertedCount: result.inserted_count,
    skippedCount: result.skipped_count,
  });
  return {
    ...result,
    proposalId: args.proposalId,
    ...(feedbackActions.has('bill.import') ? {feedback} : {}),
  };
}
