import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createTraceSink, normalizeTraceEvent} from './index.js';

const rotationBytes = 4 * 1024 * 1024;
const at = '2026-01-01T00:00:00Z';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-trace-sink-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, file: path.join(root, 'trace.jsonl')};
}

function event(runId, data = {}) {
  return {at, source: 'fixture', kind: 'fixture.trace', correlation: {runId}, data};
}

function eventAtThreshold(runId) {
  const value = {...event(runId, {padding: ''}),eventId:'fixed-fixture-event-'+runId};
  const envelopeBytes = Buffer.byteLength(`${JSON.stringify(normalizeTraceEvent(value))}\n`);
  value.data.padding = 'x'.repeat(rotationBytes - envelopeBytes);
  return value;
}

function readRunIds(file) {
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line).correlation.runId);
}

test('the default sink rotates at 4 MiB and replaces the previous generation', t => {
  const {root, file} = fixture(t);
  const sink = createTraceSink(file);
  const previous = `${file}.1`;

  sink.emit(eventAtThreshold('first'));
  assert.equal(fs.statSync(file).size, rotationBytes);
  assert.equal(fs.existsSync(previous), false);

  sink.emit(eventAtThreshold('second'));
  assert.deepEqual(readRunIds(previous), ['first']);
  assert.equal(fs.statSync(file).size, rotationBytes);

  sink.emit(event('third'));
  assert.deepEqual(fs.readdirSync(root).sort(), ['trace.jsonl', 'trace.jsonl.1']);
  assert.deepEqual(readRunIds(previous), ['second']);
  assert.deepEqual(readRunIds(file), ['third']);
});

test('maxBytes zero keeps appending past 4 MiB in the same file', t => {
  const {root, file} = fixture(t);
  const sink = createTraceSink(file, {maxBytes: 0});

  sink.emit(eventAtThreshold('first'));
  sink.emit(event('second'));

  assert.ok(fs.statSync(file).size > rotationBytes);
  assert.deepEqual(fs.readdirSync(root), ['trace.jsonl']);
  assert.deepEqual(readRunIds(file), ['first', 'second']);
});
