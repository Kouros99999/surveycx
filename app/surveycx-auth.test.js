const assert = require('node:assert/strict');
const { test } = require('node:test');
const Auth = require('./surveycx-auth.js');

test('parseJwt decodes the payload and isSupervisor reads cognito:groups in either shape', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', 'cognito:groups': ['supervisors'], 'custom:agentArn': 'arn:x' })).toString('base64url');
  const claims = Auth.parseJwt('h.' + payload + '.s');
  assert.equal(claims.sub, 'u1'); assert.equal(Auth.isSupervisor(claims), true);
  assert.equal(Auth.isSupervisor({ 'cognito:groups': 'agents supervisors' }), true);
  assert.equal(Auth.isSupervisor({ 'cognito:groups': ['agents'] }), false);
  assert.equal(Auth.parseJwt('garbage'), null);
});
