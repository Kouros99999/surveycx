# SurveyCX for Amazon Connect

Post-contact surveys for Amazon Connect, and a survey module for other contact-centre platforms. Surveys run on the IVR after the call, in chat, or by SMS and email link; answers are stored per contact and agent, reported by agent, queue, driver and period, fed into [Arena](https://github.com/Kouros99999/arena-for-connect), and a low score opens a follow-up Task. Deploys into the customer's own AWS account; billed per completed response through AWS Marketplace. By EKPK LLC.

**Live demo (simulated data):** https://kouros99999.github.io/surveycx/results.html

## What is here

| Path | What |
|---|---|
| `app/surveycx-core.js` | Shared survey engine: model, validation, targeting, question flow, prompts, scoring, aggregation, CSV. Pure, UMD, used by the Lambdas and the pages |
| `app/console.html` | Survey builder and settings (supervisors) |
| `app/results.html` | Results by agent, queue, driver, channel, period; responses; export |
| `app/survey.html` | The hosted web survey customers open from SMS, email or chat links |
| `app/serve.js` | Local dev server: the pages plus the real API over an in-memory store with demo data |
| `app/demo.js`, `app/demo-seed.js` | The website demo: the API in the browser |
| `lambda/src/flow.js` | Lambda the Connect flow module invokes: IVR and in-chat surveys |
| `lambda/src/ingest.js` | Contact records from Kinesis: agent attribution, SMS/email invitations |
| `lambda/src/delivery.js` | Invitation rules (frequency cap, send window, opt-out, reminder) and the outbox sender |
| `lambda/src/responses.js` | Response lifecycle and the closed loop: contact attributes, low-score Task, EventBridge event, Arena |
| `lambda/src/optout.js` | STOP replies from AWS End User Messaging |
| `lambda/src/api.js` | HTTP API: surveys, settings, report, responses, export, privacy, keys, web survey, ingest and data endpoints |
| `lambda/src/metering.js` | Daily Marketplace usage report (`responses` dimension) with the free trial |
| `lambda/src/contacts.js` | The canonical "contact ended" shape every connector produces |
| `lambda/src/store.js` | Single-table DynamoDB layer (`memstore.js` is the in-memory twin for tests and dev) |
| `lambda/template.yaml` | SAM stack |
| `lambda/flow-module.js` | Generates the Amazon Connect flow module JSON |
| `lambda/seller/` | Marketplace seller side: registration page and license notifications (deploy once, seller account) |
| `lambda/release.js` | Builds and publishes a release; refuses without release notes and help-center updates |
| `web/` | Public website: landing, help center (`kb/`), release notes, support, privacy; built by `build-site.js` on GitHub Pages |

## Run locally

```bash
node app/serve.js
```

Console http://localhost:8766/console.html, results http://localhost:8766/results.html, web survey http://localhost:8766/survey.html#demo. Everyone is a supervisor; nothing needs AWS.

## Test

```bash
node lambda/build.js && node --test app/surveycx-core.test.js app/surveycx-auth.test.js lambda/src/store.test.js lambda/src/flow.test.js lambda/src/delivery.test.js lambda/src/api.test.js lambda/src/metering.test.js lambda/src/clock.test.js lambda/src/site-deployer.test.js lambda/seller/register.test.js lambda/flow-module.test.js web/releases.test.js
```

## Deploy into an AWS account

```bash
cd lambda && node build.js && sam build && sam deploy --guided
```

Then: add the `FlowLambdaArn` function to the Connect instance, `node lambda/flow-module.js <FlowLambdaArn>` and import the JSON as a flow module, reference it from a disconnect flow, and send contact records to `StreamArn`. The help center article *Getting started* walks through it; *Settings reference* lists every parameter.

## How it works

**Canonical contact.** `contacts.js` defines the one shape a connector produces when a contact ends: id, channel, agent, queue, attributes, phone, email, time. Connect's contact records are translated to it in `ingest.js`; any other platform posts it to `POST /ingest/{key}/contacts`. Everything above (targeting, invitations, results, events, Arena) is platform-neutral.

**Surveys.** `surveycx-core.js` holds the survey model: six question types, one survey per queue or attribute with the most specific match winning, sampling, a skip rule, an agent-attributable flag per question, and a low-score rule. Every scored answer is normalised to 1-5 so surveys report together and Arena receives one scale.

**Voice and chat.** The flow module invokes `flow.js` with `action=start`, then `action=answer` with the customer's input until the Lambda answers `done=true`. Prompts are generated per channel (keypad on voice, "reply with a number" in chat; free text only in chat). The agent is not known in the disconnect flow; the contact record fills it in when it arrives, and the closed loop re-runs so Arena and the attributes get the agent.

**Invitations.** `delivery.considerOutbound` applies survey targeting, sampling, the opt-out list, the frequency cap (per hashed phone or email) and the send window, then queues the send in an outbox the `delivery.handler` schedule drains every five minutes: SMS through AWS End User Messaging, email through SES with a one-click rating. One optional reminder. STOP replies arrive through SNS (`optout.js`).

**Closed loop.** On completion `responses.closeLoop` writes the scores onto the contact (`UpdateContactAttributes`), opens a Task for a low score (`StartTaskContact` with the answers and links), puts an event on EventBridge, and posts `CSAT_RECEIVED` to Arena's ingest endpoint. Each step is independent and never fails the response.

**Results.** `GET /report` aggregates the period's responses (`SurveyCX.aggregate`) by agent, queue, driver, channel and day with a completion funnel; agents get only their own rows. `GET /export.csv` is one column per question. Data keys (`GET /data/{key}/responses`) serve warehouses without a sign-in.

**Metering.** A daily function counts responses completed the previous local day and reports the `responses` dimension with `BatchMeterUsage` against the buyer's license, idempotent per day, with a trial allowance. Without Marketplace parameters nothing is sent.

## Releases

`node lambda/release.js <version> --bucket <bucket>` builds `surveycx.zip`, `site.zip`, `flow-module.json`, the rewritten template and checksums under `release/<version>/` and uploads them. It refuses to run unless `web/releases.json` has the version at the top with its `docs` list, and each listed help-center article in `web/kb/index.json` is marked current for that version. Pushing the commit publishes the notes and articles on the website.

## Selling on AWS Marketplace

SaaS listing with the concurrent-agreements integration, same as Arena: the registration page in `lambda/seller/` resolves the buyer's token to a `LicenseArn` and account id and hands them a one-click CloudFormation launch with those as parameters; the stack meters against that license. Deploy the seller stack once, in the seller account, in us-east-1:

```bash
cd lambda/seller && sam build && sam deploy --guided   # ReleaseBase = the release URL, SupportEmail, MarketplaceProductCode
```
