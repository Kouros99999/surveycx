// Pushes the published release's code into every function of a stack without a CloudFormation update.
//
//   node lambda/refresh-code.js <stack name> --version 0.1.0 [--region us-east-1] [--bucket ...]
//
// Why: a release republished under the same version keeps the same S3 key, so `aws cloudformation deploy` sees no
// change and leaves the functions on the old code. For a dev stack that iterates on one version this refreshes them;
// customer stacks should always move to a new version number instead.
'use strict';
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
const stack = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const region = opt('region', process.env.AWS_REGION || 'us-east-1'), version = opt('version', ''), bucket = opt('bucket', 'surveycx-releases-533267257907');
if (!stack || !/^\d+\.\d+\.\d+$/.test(version)) { console.error('usage: node lambda/refresh-code.js <stack> --version x.y.z'); process.exit(1); }
const aws = (...a) => execFileSync('aws', [...a, '--region', region, '--output', 'json'], { encoding: 'utf8' });
const fns = JSON.parse(aws('cloudformation', 'list-stack-resources', '--stack-name', stack, '--query', "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId"));
for (const fn of fns) {
  const r = JSON.parse(aws('lambda', 'update-function-code', '--function-name', fn, '--s3-bucket', bucket, '--s3-key', `surveycx/${version}/surveycx.zip`));
  console.log(fn, r.LastUpdateStatus);
}
console.log(`${fns.length} functions now run surveycx/${version}/surveycx.zip`);
