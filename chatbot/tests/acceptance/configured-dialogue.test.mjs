import assert from 'node:assert/strict';
import test from 'node:test';
import {findObservedToolResult, observedAuthorization, observeToolResults} from './configured-dialogue.mjs';

function exchange(id, name, args, value) {
  return [
    {role: 'assistant', tool_calls: [{id, function: {name, arguments: JSON.stringify(args)}}]},
    {role: 'tool', tool_call_id: id, content: JSON.stringify(value)},
  ];
}

test('normalizes hosted dispatch targets while preserving direct tool arguments', () => {
  const results = [];
  observeToolResults()([
    ...exchange('a', 'dispatch_action', {id: 'openclaw:plugin:lookup', args: {id: 'record'}}, {ok: true}),
    ...exchange('b', 'lookup', {id: 'direct', args: {nested: true}}, {ok: false}),
  ], results);
  assert.deepEqual(results, [
    {tool: 'lookup', args: {id: 'record'}, value: {ok: true}},
    {tool: 'lookup', args: {id: 'direct', args: {nested: true}}, value: {ok: false}},
  ]);
});

test('selects the requested proposal receipt when the same turn also queries current state', () => {
  const results = [];
  observeToolResults()([
    ...exchange('a', 'state_get', {proposal_id: 'p1'}, {receipt: 'p1'}),
    ...exchange('b', 'state_get', {}, {state: 'current'}),
    ...exchange('c', 'other_state_get', {proposal_id: 'p1'}, {receipt: 'unrelated'}),
  ], results);
  assert.deepEqual(findObservedToolResult(results, 'state_get', {proposal_id: 'p1'}).value, {receipt: 'p1'});
  assert.equal(findObservedToolResult(results, 'state_get', {proposal_id: 'missing'}), undefined);
});

test('matches a focused confirmation by the authorized proposal in the response', () => {
  const results = [], draft = {domain: 'host_sudo', proposalId: 'p1', payloadHash: 'frozen'};
  observeToolResults()(exchange('a', 'dispatch_action', {
    id: 'openclaw:personal-confirmation:personal_confirmation', args: {action: 'confirm', domain: draft.domain},
  }, {ok: true, status: 'authorized', results: [{...draft, status: 'authorized', ok: true}]}), results);
  assert(observedAuthorization(results, draft));
  assert(!observedAuthorization(results, {...draft, proposalId: 'p2'}));
  assert(!observedAuthorization(results, {...draft, payloadHash: 'other'}));
});
