# Integrating VeriCX with SurveyCX

Brief for the VeriCX engineering side (or the Claude session working on VeriCX). Everything referenced here is public in https://github.com/Kouros99999/surveycx and the help center at https://surveycx.ai/kb.html.

## What SurveyCX is

A post-contact survey service by EKPK LLC. It runs as a CloudFormation stack inside an AWS account: survey builder, hosted web survey page, SMS/email invitations with sending rules, scoring (CSAT, NPS, CES, 1-5 overall, low-score flag), results by agent/queue/driver/period, webhooks, and an HTTP API. On Amazon Connect it also runs surveys on the IVR and in chat; on any other platform it works through the API. Billing is per completed response.

## The model agreed for VeriCX: one stack per client

Client data is never shared, so each VeriCX client gets their own SurveyCX stack (own table, bucket, site, keys). VeriCX provisions a client with one command, from a checkout of the repo with AWS credentials for the account the stack goes in:

```
node lambda/provision.js <client-stack-name> --version 0.1.0 --partner VeriCX --provider generic \
  --brand "<Client name>" --accent "#1d4ed8" --logo https://<client logo>.png \
  --webhook https://<vericx endpoint for this client> --secret <random 32+ chars> \
  --timezone <IANA zone> --alarm-email <ops address>
```

Output (shown once): the client's site URL (`https://<id>.cloudfront.net`), API base (`<site>/api`), an **ingest key** (`ik_…`) and a **data key** (`dk_…`). Store them per client in VeriCX. Re-run with new options to update; `--delete` removes the client stack. Stack names must be unique per AWS account; a pattern like `scx-<client-slug>` works.

For a client on Amazon Connect add `--connect-instance <id> --connect-url https://<alias>.my.connect.aws`; the output then also gives the flow Lambda ARN and the contact-record stream ARN for the Connect-side setup (help center: *Getting started*, *Surveys on voice and chat*).

## What VeriCX's platform must do per client

All calls go to that client's API base. Full details: https://surveycx.ai/kb/api-reference.html

**1. When a contact ends, either let SurveyCX invite the customer…**

`POST {api}/ingest/{ingestKey}/contacts` with `{ "contacts": [ { contactId, channel, agent, agentName, queue, phone?, email?, attributes?, endedAt, platform: "vericx" } ] }`. SurveyCX picks the survey, applies sampling, frequency cap, opt-outs and the send window, and sends SMS/email itself (the client stack needs an SES sender and/or an End User Messaging number configured; otherwise use the next option).

**…or ask for a link and deliver it in VeriCX's own channel (chat widget, app, your own SMS):**

`POST {api}/ingest/{ingestKey}/invitations` with `{ contactId, agent, agentName, queue, channel, platform: "vericx" }` → `201 { token, url, surveyId, expiresAt }`. Show `url` to the customer. Same contact always returns the same link.

To render questions inside VeriCX's UI instead of the hosted page: `GET {api}/ingest/{ingestKey}/surveys` gives the definitions; post answers with `POST {api}/s/{token}/answers { answers: { <questionId>: value } }`.

**2. Skip or force a survey when the flow already knows.** Send `attributes: { "surveycx": "skip" }` to suppress, or `"surveycx": "<survey id>"` to force one.

**3. Receive results.** Register a webhook (the provisioner does it, or Settings → Webhooks in the client's console). Every completed response is POSTed as JSON (`event`, `contactId`, `surveyId`, `channel`, `queue`, `agent`, `scores { csat, nps, ces, five, agentFive, low }`, `answers`, timestamps) with header `X-SurveyCX-Signature: sha256=<HMAC-SHA256 of the raw body with the secret>`. Verify it. Failed deliveries are not retried.

**4. Pull reports for dashboards.** `GET {api}/data/{dataKey}/report?from=YYYY-MM-DD&to=YYYY-MM-DD[&queue][&agent]` returns `overall`, `agents`, `queues`, `drivers`, `channels`, `days` with `n`, `offered`, `completion`, `csat`, `csatPct`, `nps`, `ces`, `five`, `low`. `GET {api}/data/{dataKey}/responses?from&to` returns the rows. Max 92 days per call.

**5. Agent identity.** Send a stable agent id (user id, not display name); it is what reports key on.

## Rate limits and errors

Public routes are throttled at the API gateway: 20 req/s for ingest and survey links, 2 req/s for data reads. Batch contacts (up to 200 per call). Errors are `{ "error": "…" }` with 4xx; 401 means the key is wrong, revoked or expired (keys from the provisioner last 10 years; keys made in the console default to 1 year).

## Billing

Each client stack reports its completed responses nightly. Options: every client stack launched with VeriCX's one Marketplace license (`--license-arn --customer-account --product-code`), so AWS sums them on VeriCX's bill; or clients subscribe on Marketplace themselves; or a direct contract with no Marketplace parameters, invoiced from each stack's report. Decide this with EKPK before provisioning production clients.

## Test environment

A dev stack exists today at https://d3d1039jkgi82q.cloudfront.net (API base `https://d3d1039jkgi82q.cloudfront.net/api`). Ask EKPK for an ingest key and a data key to try the calls above before provisioning anything.

## Contact

support@surveycx.ai (EKPK LLC).
