// Cron 健康判定的离线测试；不读取运行数据库、不调用 Gateway。
// 对应文档：docs/9_QQ融合助手架构与开发计划.md「如何验证」。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cronIssues} from '../lib/health-cron.mjs';

const job = (overrides = {}) => ({id: 'job-1', enabled: true, state: {lastRunStatus: 'ok', lastDeliveryStatus: 'delivered'}, ...overrides});

test('正常任务不产生 issue', () => {
  assert.deepEqual(cronIssues([job()]), []);
});

test('lastRunStatus=error 计入失败', () => {
  assert.deepEqual(cronIssues([job({state: {lastRunStatus: 'error'}})]), ['Cron job job-1 last run failed']);
});

test('旧字段 lastStatus=error 也计入失败', () => {
  assert.deepEqual(cronIssues([job({state: {lastStatus: 'error'}})]), ['Cron job job-1 last run failed']);
});

test('skipped 与 not-requested 是有意行为', () => {
  assert.deepEqual(cronIssues([job({state: {lastRunStatus: 'skipped', lastDeliveryStatus: 'not-requested'}})]), []);
});

test('未送达与未知送达要求对账', () => {
  assert.deepEqual(cronIssues([job({state: {lastRunStatus: 'ok', lastDeliveryStatus: 'not-delivered'}})]), ['Cron job job-1 delivery not-delivered requires reconciliation']);
  assert.deepEqual(cronIssues([job({state: {lastRunStatus: 'ok', lastDeliveryStatus: 'unknown'}})]), ['Cron job job-1 delivery unknown requires reconciliation']);
});

test('禁用任务的历史失败不报告，缺失状态不报错', () => {
  assert.deepEqual(cronIssues([job({enabled: false, state: {lastRunStatus: 'error'}})]), []);
  assert.deepEqual(cronIssues([{id: 'job-2', enabled: true}]), []);
  assert.deepEqual(cronIssues([]), []);
});
