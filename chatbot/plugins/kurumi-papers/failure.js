// Bounded task diagnostics shared by status and background notices. Contract: docs/22.
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const code = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : undefined;
const stages = {'Translate Paragraphs':'翻译正文','Save PDF':'保存PDF','PDF Parsing':'解析PDF','Typesetting':'排版'};
const compact = value => Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined));
const number = n => n.toLocaleString('en-US');
const quota = new Set(['insufficient_quota','quota_exceeded','credit_balance_too_low']);
const auth = new Set(['invalid_api_key','authentication_error','key_disabled']);
const channelCodes = new Set(['rate_limit_exceeded','upstream_stream_read_error','upstream_error','server_error','internal_server_error','service_unavailable','overloaded_error','gateway_timeout','upstream_http2_stream_error','api_transport_unknown','api_request_timed_out_unknown','api_output_idle_timed_out_unknown','api_stream_interrupted_unknown']);

export function failureSummary(job, config = {}) {
  const deliveryFailure = job.status === 'succeeded' && job.delivery?.status === 'failed_or_unknown';
  if (job.status !== 'failed' && job.status !== 'interrupted' && !deliveryFailure) return undefined;
  const usage = job.usage ?? {}, receipts = Array.isArray(usage.receipts) ? usage.receipts : [];
  const error = deliveryFailure ? 'pdf_delivery_failed_or_unknown' : code(job.error) ?? 'translation_failed';
  const last = [...receipts].reverse().find(r => ['channel_failed','credential_rejected','quota_or_rate_limit','request_rejected'].includes(r.outcome));
  const upstream = code(last?.apiErrorCode ?? last?.failoverReason ?? last?.error);
  const httpStatus = Number.isInteger(last?.httpStatus) && last.httpStatus >= 400 && last.httpStatus <= 599 ? last.httpStatus : undefined;
  const upstreamCode = quota.has(upstream) || auth.has(upstream) || channelCodes.has(upstream) || /^responses_http_\d{3}$/.test(upstream ?? '') ? upstream : (httpStatus ? 'responses_http_'+httpStatus : undefined);
  // Earlier recovered channel errors cannot replace the actual terminal failure.
  const terminalCode = ['all_translation_channels_failed','all_translation_credentials_unavailable'].includes(error) ? upstreamCode : error;
  const counters = compact(Object.fromEntries(['requests','maxRequests','inputTokens','outputTokens','reportedTokens','maxReportedTokens','unknownUsageAttempts','validationFailures','channelFailures'].map(k => [k,count(usage[k])])));
  const exhaustedBy = ['requests','reported_tokens'].includes(usage.failureDetails?.budgetExhaustedBy) ? usage.failureDetails.budgetExhaustedBy : undefined;
  const stage = deliveryFailure ? '文件投递' : stages[job.engineProgress?.stage] ?? '论文处理';
  let reason, nextStep = '请确认后再安排重试；本次不会自动重新翻译。';
  if (error === 'translation_budget_exhausted') {
    const requests = exhaustedBy === 'requests';
    const used = requests ? counters.requests : counters.reportedTokens;
    const limit = requests ? counters.maxRequests : counters.maxReportedTokens;
    reason = used !== undefined && limit !== undefined
      ? `达到本地单篇${requests ? 'API请求' : '已报告token'}上限：${number(used)} / ${number(limit)}。`
      : '达到本地单篇用量或请求数上限。';
    reason += '这不是账号余额不足的判断。';
    nextStep = '可确认后选择页码、模型或调整单篇预算再试；本次不会自动增加预算或重译。';
  } else if (deliveryFailure) {
    reason = '译文已生成，但QQ文件投递失败或回执未知。';
    nextStep = '请先确认是否已收到文件；无需重新翻译，确认需要后再安排发送。';
  } else if (error === 'translation_timed_out') {
    reason = `超过单篇执行时限${count(config.timeoutSeconds) !== undefined ? `（${config.timeoutSeconds}秒）` : ''}。`;
  } else if (error === 'gateway_restarted_no_automatic_replay' || job.status === 'interrupted') {
    reason = '后台服务重启或停止，未完成任务已中断；没有自动续跑付费调用。';
  } else if (quota.has(terminalCode) || (job.profile?.provider === 'deepseek' && terminalCode === 'responses_http_402')) {
    reason = '所选翻译渠道报告额度不足或账户配额受限；需要核对该渠道的余额/配额，本地没有查询账户余额。';
    nextStep = '请检查所选渠道的计费/额度设置，确认后再试。';
  } else if (auth.has(terminalCode) || terminalCode === 'responses_http_401' || error === 'translation_credentials_not_configured' || error === 'translation_credentials_invalid') {
    reason = '所选翻译渠道的密钥未配置、格式/权限不符合要求，或上游拒绝鉴权。';
    nextStep = '请检查论文凭据文件中所选厂商的密钥与文件权限，不需要把密钥发到聊天里。';
  } else if (terminalCode === 'rate_limit_exceeded' || terminalCode === 'responses_http_429') {
    reason = '所选翻译渠道报告请求过快或并发受限；这不是账号余额不足的判断。';
    nextStep = '可稍后确认重试，或由操作者核对渠道限流与并发配置。';
  } else if (['all_translation_channels_failed','all_translation_credentials_unavailable'].includes(error) || /^responses_http_5\d\d$/.test(terminalCode ?? '')) {
    reason = upstreamCode?.includes('idle') ? '所选翻译渠道长时间没有有效正文，切换/有界恢复后仍未完成。' : '所选翻译渠道均失败、限流或处于冷却中，有界恢复后仍未完成。';
  } else if (['invalid_batch_translation','translation_placeholder_mismatch'].includes(error)) {
    reason = '模型返回的译文未通过结构、公式或样式标记校验，当前批次重试后仍失败。';
  } else if (error === 'api_usage_unknown') {
    reason = '翻译渠道没有返回可核实用量，为避免无法核算的持续调用已停止。';
  } else if (['api_model_mismatch','api_effort_mismatch'].includes(error)) {
    reason = '翻译渠道回显的模型或推理强度与本次要求不一致，已停止。';
  } else if (error === 'missing_selected_pdf_output' || error.startsWith('pdf_engine_')) {
    reason = 'PDF处理/排版未能生成本次要求的完整译稿。';
  } else {
    reason = '后台论文处理失败，当前记录尚不能进一步确定原因。';
  }
  const profile = compact(Object.fromEntries(['provider','channel','model','effort'].map(k => [k,code(job.profile?.[k])])));
  const summary = compact({jobId:code(job.id),code:error,stage,reason,nextStep,profile,exhaustedBy,upstreamCode,counters,hasCompleteArtifact:job.status === 'succeeded'});
  summary.message = `${deliveryFailure ? '论文译文投递遇到问题' : '这篇论文未完成翻译'}（${stage}）：${reason}`
    + (counters.unknownUsageAttempts ? `另有${counters.unknownUsageAttempts}次请求用量未知，不能视为零消耗。` : '')
    + `${deliveryFailure ? '' : '尚无完整译稿可投递。'}${nextStep}\n任务：${summary.jobId ?? '未知'}；诊断码：${error}`;
  return summary;
}
