#!/usr/bin/env bash
# 兼容旧命令名的薄入口：实际由 kurumi-stack 统一管理。
# 对应文档：docs/9_QQ融合助手架构与开发计划.md「统一启停（kurumi-stack）」。
set -euo pipefail
STACK_BIN="${KURUMI_STACK_BIN:-$HOME/.local/bin/kurumi-stack}"
exec "$STACK_BIN" start "$@"
