// Cron 健康判定：只把“已启用任务的真实失败”报告为 issue。
// skipped 与 not-requested 是有意行为，不算失败；lastStatus 是 lastRunStatus 的
// 旧别名（OpenClaw 2026.11.1 仍可能返回），两者都识别。
export function cronIssues(jobs = []) {
  const issues = [];
  for (const job of jobs) {
    if (!job || job.enabled === false) continue;
    const id = job.id ?? '(unknown)';
    const state = job.state ?? {};
    const runStatus = state.lastRunStatus ?? state.lastStatus ?? null;
    if (runStatus === 'error') issues.push(`Cron job ${id} last run failed`);
    else if (runStatus && runStatus !== 'ok' && runStatus !== 'skipped') issues.push(`Cron job ${id} last run status ${runStatus}`);
    const delivery = state.lastDeliveryStatus ?? null;
    if (delivery === 'not-delivered' || delivery === 'unknown') issues.push(`Cron job ${id} delivery ${delivery} requires reconciliation`);
  }
  return issues;
}
