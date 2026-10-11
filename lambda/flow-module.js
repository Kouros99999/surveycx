// Generates the Amazon Connect flow module that runs a SurveyCX survey in a disconnect flow (voice and chat).
//
//   node lambda/flow-module.js <flow Lambda ARN> [out.json]
//
// Import the JSON in the Connect console (Routing > Flows > Modules > Create > Import), then in each inbound flow
// add a "Set disconnect flow" block pointing at a small flow that invokes this module. The module:
//   1. invokes the Lambda with action=start; if eligible, plays the intro and the first prompt
//   2. collects the customer's input (DTMF on voice, a typed reply on chat), sends it back with action=answer
//   3. repeats until the Lambda answers done=true, plays the outro and ends the module
// The Lambda must be added to the instance first (Connect console > Flows > AWS Lambda), or the import fails to resolve it.
'use strict';
const fs = require('fs');

function build(lambdaArn) {
  const id = (n) => `surveycx-${n}`;
  const lambda = (name, attrs, next) => ({ Identifier: id(name), Type: 'InvokeLambdaFunction', Parameters: { LambdaFunctionARN: lambdaArn, InvocationTimeLimitSeconds: '8', LambdaInvocationAttributes: attrs, ResponseValidation: { ResponseType: 'STRING_MAP' } }, Transitions: { NextAction: id(next), Errors: [{ NextAction: id('end'), ErrorType: 'NoMatchingError' }] } });
  const compare = (name, value, yes, no) => ({ Identifier: id(name), Type: 'Compare', Parameters: { ComparisonValue: value }, Transitions: { NextAction: id(no), Conditions: [{ NextAction: id(yes), Condition: { Operator: 'Equals', Operands: ['true'] } }], Errors: [{ NextAction: id(no), ErrorType: 'NoMatchingCondition' }] } });
  const say = (name, text, next) => ({ Identifier: id(name), Type: 'MessageParticipant', Parameters: { Text: text }, Transitions: { NextAction: id(next), Errors: [{ NextAction: id(next), ErrorType: 'NoMatchingError' }] } });
  const actions = [
    lambda('start', { action: 'start' }, 'eligible'),
    compare('eligible', '$.External.eligible', 'intro', 'end'),
    say('intro', '$.External.intro', 'done-after-start'),
    compare('done-after-start', '$.External.done', 'outro', 'ask'),
    { Identifier: id('ask'), Type: 'GetParticipantInput', Parameters: { Text: '$.External.prompt', StoreInput: 'True', InputTimeLimitSeconds: '10', DTMFConfiguration: { DisableCancelKey: 'False', InputTerminationSequence: '#' }, InputValidation: { CustomValidation: { MaximumLength: '$.External.digits' } } },
      Transitions: { NextAction: id('answer'), Errors: [{ NextAction: id('timeout'), ErrorType: 'InputTimeLimitExceeded' }, { NextAction: id('answer'), ErrorType: 'NoMatchingCondition' }, { NextAction: id('end'), ErrorType: 'NoMatchingError' }] } },
    lambda('answer', { action: 'answer', digits: '$.StoredCustomerInput' }, 'done'),
    compare('done', '$.External.done', 'outro', 'ask'),
    say('timeout', 'We did not get an answer. Thank you for your time. Goodbye.', 'end'),
    say('outro', '$.External.outro', 'end'),
    { Identifier: id('end'), Type: 'EndFlowModuleExecution', Parameters: {}, Transitions: {} },
  ];
  return { Version: '2019-10-30', StartAction: id('start'), Metadata: { entryPointPosition: { x: 40, y: 40 }, ActionMetadata: Object.fromEntries(actions.map((a, i) => [a.Identifier, { position: { x: 40 + (i % 5) * 260, y: 40 + Math.floor(i / 5) * 220 } }])), name: 'SurveyCX survey', description: 'Runs the SurveyCX post-contact survey. Use from a disconnect flow for voice and chat.', type: 'contactFlowModule', status: 'published' }, Actions: actions, Settings: { InputParameters: [], OutputParameters: [], Transitions: [{ DisplayName: 'Success', ReferenceName: 'Success', Description: '' }, { DisplayName: 'Error', ReferenceName: 'Error', Description: '' }] } };
}

if (require.main === module) {
  const arn = process.argv[2], out = process.argv[3] || 'surveycx-flow-module.json';
  if (!arn || !/^arn:aws:lambda:/.test(arn)) { console.error('usage: node lambda/flow-module.js <flow Lambda ARN> [out.json]'); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify(build(arn), null, 2) + '\n');
  console.log('wrote', out, '- import it as a flow module in the Amazon Connect console, then reference it from a disconnect flow.');
}
module.exports = { build };
