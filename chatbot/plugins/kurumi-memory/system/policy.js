// Document 29 fixed schema marker and record text policy; no database or transport.
import fs from 'node:fs';
import {CREDENTIAL_PATTERN} from '../model.js';
const fail=code=>Object.assign(Error(code),{code});
export const NOTICE_V3 = '# 个人记忆\n\n<!-- KURUMI_MEMORY_SYSTEM_V3 -->\n记录、版本、原文镜像与遗忘遮罩由受限记忆工具管理，唯一事实保存在 .kurumi-memory/state.sqlite。\n本文件不保存正文。原文只追加；遗忘遮罩不删除原聊天或开发日志。\n';
export const SCHEMA_V3 = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
export const recordText = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || CREDENTIAL_PATTERN.test(value)) throw fail('invalid_memory_text');
  return value.trim();
};
