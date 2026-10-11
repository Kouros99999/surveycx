// Builds a self-contained release of the SurveyCX stack for AWS Marketplace or any customer account.
//
//   node lambda/release.js <version> [--bucket <public artifacts bucket>] [--region us-east-1] [--no-upload]
//
// Produces release/<version>/surveycx.zip (all Lambda code), release/<version>/template.yaml (every CodeUri
// rewritten to the public S3 location), release/<version>/site.zip (the pages) and the release notes.
// With --bucket it uploads everything to s3://<bucket>/surveycx/<version>/ (the bucket policy grants public read).
//
// Release notes and the help center come first: the script refuses to run until web/releases.json has an entry for
// the version at the top, naming the help-center articles it changed, each marked current for that version.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) { console.error('usage: node lambda/release.js <x.y.z> [--bucket B] [--region R] [--no-upload]'); process.exit(1); }
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const bucket = opt('bucket', process.env.SURVEYCX_RELEASE_BUCKET || ''), region = opt('region', process.env.AWS_REGION || 'us-east-1');
const upload = !args.includes('--no-upload') && !!bucket;

const root = path.join(__dirname, '..');
const notes = JSON.parse(fs.readFileSync(path.join(root, 'web', 'releases.json'), 'utf8'));
const entry = notes.find((n) => n.version === version);
if (!entry || !Array.isArray(entry.changes) || !entry.changes.length) {
  console.error(`No release notes for ${version}.\nAdd an entry at the top of web/releases.json (version, date, title, summary, changes, upgrade, docs) and run this again.`);
  process.exit(1);
}
if (!Array.isArray(entry.docs)) { console.error(`The ${version} entry in web/releases.json needs a "docs" list: the help-center article slugs this release changed (an empty list is allowed when nothing changed).`); process.exit(1); }
const kb = JSON.parse(fs.readFileSync(path.join(root, 'web', 'kb', 'index.json'), 'utf8'));
for (const slug of entry.docs) {
  const a = kb.find((x) => x.slug === slug);
  if (!a) { console.error(`Release notes name help-center article "${slug}" but web/kb/index.json has no such article.`); process.exit(1); }
  if (a.updated !== version) { console.error(`Help-center article "${slug}" is listed as changed in ${version} but web/kb/index.json marks it current as of ${a.updated}. Update the article and set "updated" to ${version}.`); process.exit(1); }
  if (!fs.existsSync(path.join(root, 'web', 'kb', slug + '.md'))) { console.error(`web/kb/${slug}.md is missing.`); process.exit(1); }
}
if (notes[0].version !== version && !args.includes('--allow-older')) { console.error(`web/releases.json lists ${notes[0].version} first, not ${version}. Put the newest version at the top, or pass --allow-older to rebuild an earlier one.`); process.exit(1); }
const out = path.join(root, 'release', version);
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'RELEASE_NOTES.json'), JSON.stringify(entry, null, 2) + '\n');

// 1. Lambda code: src/ plus the shared core, files at the archive root.
fs.copyFileSync(path.join(root, 'app', 'surveycx-core.js'), path.join(__dirname, 'src', 'surveycx-core.js'));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'surveycx-rel-'));
for (const f of fs.readdirSync(path.join(__dirname, 'src'))) if (!f.endsWith('.test.js') && f !== 'memstore.js') fs.copyFileSync(path.join(__dirname, 'src', f), path.join(stage, f));
zip(stage, path.join(out, 'surveycx.zip'));

// 2. Pages.
const site = fs.mkdtempSync(path.join(os.tmpdir(), 'surveycx-site-'));
for (const f of ['console.html', 'results.html', 'survey.html', 'surveycx-core.js', 'surveycx-auth.js', 'common.js', 'app.css', 'logo.svg']) fs.copyFileSync(path.join(root, 'app', f), path.join(site, f));
zip(site, path.join(out, 'site.zip'));

// 3. The flow module for this release, with a placeholder ARN the customer replaces (or regenerates with the script).
fs.writeFileSync(path.join(out, 'flow-module.json'), JSON.stringify(require('./flow-module.js').build('arn:aws:lambda:REGION:ACCOUNT:function:surveycx-flow-STACK'), null, 2) + '\n');

// 4. Template with every CodeUri pointing at the published archive.
const codeUri = bucket ? `s3://${bucket}/surveycx/${version}/surveycx.zip` : `./surveycx.zip`;
let tpl = fs.readFileSync(path.join(__dirname, 'template.yaml'), 'utf8');
const before = (tpl.match(/CodeUri: src\//g) || []).length;
tpl = tpl.replace(/CodeUri: src\/[^\n]*/g, `CodeUri: ${codeUri}`);
tpl = tpl.replace(/^Description: (.*)$/m, `Description: SurveyCX for Amazon Connect v${version}. $1`);
if (bucket) tpl = tpl.replace(/(  SiteArchiveUrl:\n    Type: String\n    Default: )''/, `$1'https://${bucket}.s3.${region}.amazonaws.com/surveycx/${version}/site.zip'`);
fs.writeFileSync(path.join(out, 'template.yaml'), tpl);

// 5. Checksums.
const crypto = require('crypto');
fs.writeFileSync(path.join(out, 'SHA256SUMS'), ['surveycx.zip', 'site.zip', 'template.yaml', 'flow-module.json'].map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(out, f))).digest('hex')}  ${f}`).join('\n') + '\n');
console.log(`release ${version}: ${before} functions -> ${codeUri}`);
console.log(fs.readdirSync(out).map((f) => `  ${f}  ${fs.statSync(path.join(out, f)).size} bytes`).join('\n'));

// 6. Publish.
if (upload) {
  const aws = (...a) => execFileSync('aws', [...a, '--region', region], { encoding: 'utf8' }).trim();
  for (const f of fs.readdirSync(out)) aws('s3', 'cp', path.join(out, f), `s3://${bucket}/surveycx/${version}/${f}`, '--cache-control', 'public, max-age=31536000, immutable');
  console.log(`published to s3://${bucket}/surveycx/${version}/`);
  console.log(`template URL: https://${bucket}.s3.${region}.amazonaws.com/surveycx/${version}/template.yaml`);
  console.log(`\nNext: commit and push. The push publishes the ${version} notes and help center to the website.`);
} else if (bucket) console.log('upload skipped (--no-upload)');
else console.log('no --bucket given: template references ./surveycx.zip; run `aws cloudformation package` on it or pass --bucket to publish');

function zip(dir, dest) {
  if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path "${dir}\\*" -DestinationPath "${dest}" -CompressionLevel Optimal -Force`]);
  else execFileSync('zip', ['-qr', dest, '.'], { cwd: dir });
}
