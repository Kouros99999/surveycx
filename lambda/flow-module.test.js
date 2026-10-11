const assert = require('node:assert/strict');
const { test } = require('node:test');
const { build } = require('./flow-module.js');

test('flow module is a closed graph that loops ask -> answer -> done until the Lambda says so', () => {
  const m = build('arn:aws:lambda:us-east-1:123456789012:function:surveycx-flow-dev');
  const ids = new Set(m.Actions.map((a) => a.Identifier));
  for (const a of m.Actions) {
    const targets = [a.Transitions.NextAction, ...(a.Transitions.Conditions || []).map((c) => c.NextAction), ...(a.Transitions.Errors || []).map((e) => e.NextAction)].filter(Boolean);
    for (const t of targets) assert.ok(ids.has(t), `${a.Identifier} -> ${t} exists`);
    assert.ok(m.Metadata.ActionMetadata[a.Identifier], 'position for ' + a.Identifier);
  }
  assert.equal(m.StartAction, 'surveycx-start');
  const start = m.Actions.find((a) => a.Identifier === 'surveycx-start');
  assert.equal(start.Parameters.LambdaInvocationAttributes.action, 'start'); assert.match(start.Parameters.LambdaFunctionARN, /surveycx-flow-dev/);
  const answer = m.Actions.find((a) => a.Identifier === 'surveycx-answer');
  assert.equal(answer.Parameters.LambdaInvocationAttributes.digits, '$.StoredCustomerInput');
  const done = m.Actions.find((a) => a.Identifier === 'surveycx-done');
  assert.equal(done.Transitions.Conditions[0].NextAction, 'surveycx-outro'); assert.equal(done.Transitions.NextAction, 'surveycx-which');
  for (const n of ['surveycx-ask', 'surveycx-ask2']) { const a = m.Actions.find((x) => x.Identifier === n); assert.equal(a.Parameters.StoreInput, 'True'); assert.deepEqual(a.Transitions.Errors.map((e) => e.ErrorType), ['NoMatchingError'], 'stored input allows only NoMatchingError'); }
  assert.equal(m.Actions.find((x) => x.Identifier === 'surveycx-ask2').Parameters.InputValidation.CustomValidation.MaximumLength, '2');
  assert.equal(m.Metadata.type, 'contactFlowModule'); assert.equal(m.Actions.at(-1).Type, 'EndFlowModuleExecution');
});
