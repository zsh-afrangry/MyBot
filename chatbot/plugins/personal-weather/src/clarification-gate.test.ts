import { describe, it, expect } from 'vitest';
import { createClarificationGate } from './clarification-gate.js';
const event = { toolName: 'proposal', runId: 'run', result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, requiresUserInput: true }) }] } };
const context = { runId: 'run', sessionKey: 'session' };
describe('clarification gate', () => {
  it('blocks subsequent same-tool calls only in the same run and session', () => {
    const gate = createClarificationGate(new Set(['proposal']));
    gate.afterTool(event, context);
    expect(gate.beforeTool(event, context)?.block).toBe(true);
    expect(gate.beforeTool({ ...event, runId: 'next' }, { ...context, runId: 'next' })).toBeUndefined();
    expect(gate.beforeTool(event, { ...context, sessionKey: 'other' })).toBeUndefined();
    expect(gate.beforeTool({ ...event, toolName: 'read' }, context)).toBeUndefined();
  });
  it('does not infer clarification from ordinary errors or missing/mismatched context', () => {
    const gate = createClarificationGate(new Set(['proposal']));
    gate.afterTool(event, { runId: 'different', sessionKey: 'session' });
    gate.afterTool(event, {});
    gate.afterTool({ ...event, result: { content: [{ type: 'text', text: '{"ok":false}' }] } }, context);
    expect(gate.beforeTool(event, context)).toBeUndefined();
  });
  it('expires entries and bounds capacity', () => {
    let now = 0;
    const gate = createClarificationGate(new Set(['proposal']), () => now);
    gate.afterTool(event, context);
    now = 300_000;
    expect(gate.beforeTool(event, context)).toBeUndefined();
    for (let i = 0; i < 257; i++) gate.afterTool({ ...event, runId: String(i) }, { ...context, runId: String(i) });
    expect(gate.beforeTool({ ...event, runId: '0' }, { ...context, runId: '0' })).toBeUndefined();
    expect(gate.beforeTool({ ...event, runId: '256' }, { ...context, runId: '256' })?.block).toBe(true);
  });
});
