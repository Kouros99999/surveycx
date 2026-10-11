# API reference

SurveyCX is built to be used from other applications: a contact-centre platform that is not Amazon Connect, a vendor's own agent desktop or chat widget, a CRM, or a BI tool. Everything the console does goes through the same HTTP API, under `https://<SiteUrl>/api`.

Two kinds of credential exist, both created in *Settings > Other platforms and BI* and shown once:

- an **ingest key** (`ik_…`) lets an application report contacts, request survey links and post answers;
- a **data key** (`dk_…`) is read-only: responses and the aggregate report.

A key can be **bound to a tenant** when it is created. Everything an ingest key creates is then tagged with that tenant, and a data key reads only that tenant's responses, so a partner serving several clients from one SurveyCX stack gives each client its own pair of keys and each sees only its own data. A key without a tenant sees everything and may pass `tenant=` on data calls to filter. Contacts and responses may also carry a `tenant` field themselves (ignored when the key is bound). Keys expire (one year by default) and can be revoked. Requests are JSON; errors are `{ "error": "…" }` with a 4xx status. Public routes are rate-limited (20 requests a second for ingest and survey links, 2 for data).

## Report finished contacts

`POST /api/ingest/{key}/contacts`

```json
{ "contacts": [ { "contactId": "conv-8f3a", "channel": "voice", "agent": "user-42", "agentName": "Ann Lee", "queue": "Support",
    "phone": "+15550100100", "email": "ann@example.com", "attributes": { "intent": "billing" }, "endedAt": "2026-10-11T15:04:05Z", "platform": "genesys" } ] }
```

SurveyCX picks the survey, applies sampling, the frequency cap, opt-outs and the send window, and sends the SMS or email itself. The reply lists, per contact, `invited` and a `reason`. Up to 200 per call.

## Ask for a survey link and deliver it yourself

`POST /api/ingest/{key}/invitations`

```json
{ "contactId": "conv-8f3a", "agent": "user-42", "agentName": "Ann Lee", "queue": "Support", "channel": "chat", "platform": "vericx", "surveyId": "default" }
```

Returns `201 { "token", "url", "surveyId", "expiresAt" }`. Put the URL in your own chat widget, SMS, email or app; the hosted survey page handles the rest and the response is attributed to the agent and queue you sent. The same contact always gets the same link. `surveyId` is optional when targeting (queue, attributes) can pick the survey. Add `"deliver": true` to have SurveyCX send it instead (then `phone` or `email` is needed and the usual rules apply). Opted-out customers get `invited: false`.

## Read the survey definitions

`GET /api/ingest/{key}/surveys`

Returns the active surveys with their questions (`id`, `type`, `text`, `options`, `required`, `skipUnless`, `agentAttributable`), intro and outro, for an application that renders the questions in its own interface. Answer scales are: `rating` 1-5, `nps` 0-10, `ces` 1-7, `yesno` 1 or 0, `choice` 1..n, `text` free text.

## Post answers collected elsewhere

`POST /api/ingest/{key}/responses`

```json
{ "responses": [ { "contactId": "conv-8f3a", "surveyId": "default", "agent": "user-42", "queue": "Support", "channel": "voice",
    "at": "2026-10-11T15:10:00Z", "answers": { "csat": 4, "resolved": 1, "nps": 8 } } ] }
```

Each response is stored, scored and closed-loop processed like SurveyCX's own (Task on Connect, event, webhooks, Arena). A contact already surveyed counts as a duplicate. Answers collected through a link from the invitations call go through the survey page's own endpoints instead:

- `GET /api/s/{token}` the survey, brand and answers so far;
- `POST /api/s/{token}/answers { "answers": { "csat": 4 }, "finish": false }` save one or more answers; the survey completes when every required question is answered unless `finish` is false;
- `POST /api/s/{token}/optout`.

## Read results

`GET /api/data/{key}/responses?from=2026-10-01&to=2026-10-31` the rows (one per response, with `answers` and `scores`), up to 92 days per call.

`GET /api/data/{key}/report?from&to[&surveyId][&queue][&agent][&tenant]` the aggregate the results page shows: `overall`, `agents`, `queues`, `drivers`, `channels`, `tenants`, `days`, each with `n`, `offered`, `completion`, `csat`, `csatPct`, `nps`, `ces`, `five`, `low`.

## Webhooks

*Settings > Webhooks* takes up to five HTTPS URLs, each with an optional secret and the events it wants: `completed` (every response) or `low` (low scores only). Each completed response is POSTed once as JSON:

```json
{ "event": "survey.completed.low", "contactId": "conv-8f3a", "tenant": "acme", "surveyId": "default", "surveyName": "Post-contact survey", "platform": "connect",
  "channel": "voice", "queue": "Support", "agent": "arn:…", "agentName": "Ann Lee",
  "scores": { "csat": 1, "nps": 3, "ces": 2, "five": 1.5, "agentFive": 1, "low": true }, "answers": { "csat": 1, "why": "Waited 40 minutes" },
  "startedAt": "…", "completedAt": "…" }
```

With a secret, the header `X-SurveyCX-Signature: sha256=<hex>` is the HMAC-SHA256 of the raw body; verify it before trusting the payload. A webhook that fails is logged and not retried; the same data is also on EventBridge (`source: surveycx`) inside the AWS account for anything that lives there.

## Identity in a multi-vendor setup

The `agent` you send is stored as-is and is what reports and Arena use, so send a stable id (a user id, not a display name). If the same person appears under two ids, Arena's linked ids merge them on its side; SurveyCX reports them separately.
