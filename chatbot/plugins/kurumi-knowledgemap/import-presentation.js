import path from 'node:path';
import {freezeConfirmationFacts} from '../../packages/confirmation-core/dist/index.js';

// Staging prefixes are storage metadata. Strip one only when it matches
// the actual file digest, so ordinary names with underscores are preserved.
export function billFileLabel(fileName, digest) {
  let name = path.basename(fileName);
  const prefix = name.match(/^(?:\d+_)?([a-f0-9]{12})_/u);
  if (prefix && prefix[1] === digest?.slice(0, 12)) name = name.slice(prefix[0].length);
  return name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 160) || '账单文件';
}

const overlapCount = row => row.manual_overlap_hints?.length ?? 0;

function labelsForTags(tags) {
  if (!tags.length) return '无';
  return tags.slice(0, 12).map(tag => tag.parent_name ? tag.parent_name + '/' + tag.name : tag.name).join('、')
    + (tags.length > 12 ? ' 等（共 ' + tags.length + ' 个）' : '');
}

export function identicalBillFiles(files) {
  const byDigest = new Map();
  for (const [index, file] of files.entries()) {
    const matching = byDigest.get(file.fileSha256) ?? [];
    matching.push(index + 1);
    byDigest.set(file.fileSha256, matching);
  }
  return [...byDigest.values()].filter(group => group.length > 1);
}

export function billImportPresentation(files, preview, group) {
  const facts = group ? ['账单导入预览 · 按以下顺序一次提交'] : ['账单导入预览 · ' + files[0].fileName];
  if (preview.date_from) facts.push(`时间范围：${preview.date_from} 至 ${preview.date_to}`);
  facts.push(
    `待导入：${preview.insert_count} 笔（支出 ${preview.total_expense} 元，收入 ${preview.total_income} 元）`,
    `将跳过：重复账单 ${preview.skipped_count} 笔，0 元记录 ${files.reduce((sum, file) => sum + file.zeroAmountSkippedCount, 0)} 笔`,
  );
  const plans = group ? preview.files : [preview];
  if (group) {
    for (const [index, plan] of plans.entries()) {
      facts.push(`第 ${index + 1} 份 · ${files[index].fileName}｜新增 ${plan.insert_count} 笔（支出 ${plan.total_expense} 元，收入 ${plan.total_income} 元），重复 ${plan.skipped_count} 笔，0 元 ${files[index].zeroAmountSkippedCount} 笔`);
    }
    for (const matching of identicalBillFiles(files)) {
      facts.push(`第 ${matching.join('、')} 份文件内容相同。`);
    }
  }
  const tags = plans.flatMap(plan => plan.planned_new_tags ?? []);
  facts.push('拟新增分类标签：' + labelsForTags(tags));
  const ids = new Set(plans.flatMap(plan => (plan.manual_overlap_hints ?? []).map(row => row.bill_id)));
  const hints = group ? ids.size : overlapCount(preview);
  facts.push(`疑似手工同日同额重叠：${hints} 笔（仅提示，不自动合并）`);
  return freezeConfirmationFacts(facts);
}

// Batch rows from earlier releases may still carry the on-disk name.
export function publicBillImportResult(result) {
  const {
    file_sha256: digest, file_name: fileName, preview_hash: _previewHash,
    request_key: _requestKey, run_id: _runId, files, ...fields
  } = result;
  return {
    ...fields,
    ...(typeof fileName === 'string' && {file_name: billFileLabel(fileName, digest)}),
    ...(Array.isArray(files) && {files: files.map(publicBillImportResult)}),
  };
}
