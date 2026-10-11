# Genesys and other platforms

Everything above the data feed in SurveyCX is platform-neutral: the survey builder, the hosted web survey, SMS and email invitations with their rules, the results, the events and the Arena feed. Amazon Connect is one connector (the flow module and the contact record stream). Any other platform, or middleware in front of it, connects through two endpoints authenticated by an **ingest key**.

Create keys in *Settings > Other platforms and BI*. A key is shown once.

## Reporting finished contacts

```
POST https://<SiteUrl>/api/ingest/<key>/contacts
{ "contacts": [
  { "contactId": "conv-8f3a", "channel": "voice", "agent": "genesys-user-42", "agentName": "Ann Lee",
    "queue": "Support", "phone": "+15550100100", "email": "ann@example.com",
    "attributes": { "intent": "billing" }, "endedAt": "2026-10-11T15:04:05Z", "platform": "genesys" } ] }
```

Each contact is matched to a survey (queue, attribute, channel), sampled, checked against the frequency cap and the opt-out list, and queued for SMS or email inside the send window. The reply says what happened to each (`invited`, `opted out`, `no survey for this contact`, …). Up to 200 contacts per call; send them as they end or in a batch every few minutes.

On **Genesys Cloud** the simplest source is a conversation-end trigger (Event Orchestration or a Data Action workflow) that posts the conversation id, agent, queue and the customer's number to this endpoint. On NICE, Five9, Talkdesk or a homegrown platform, any webhook or scheduled export that knows when a contact ended will do.

## Posting answers collected elsewhere

If the platform already asked the questions (a native IVR survey, a bot), post the answers and SurveyCX stores, scores and closes the loop on them like its own:

```
POST https://<SiteUrl>/api/ingest/<key>/responses
{ "responses": [
  { "contactId": "conv-8f3a", "surveyId": "default", "agent": "genesys-user-42", "queue": "Support",
    "channel": "voice", "at": "2026-10-11T15:10:00Z", "answers": { "csat": 4, "resolved": 1, "nps": 8 } } ] }
```

Answer keys are the question ids from the survey builder. `surveyId` is optional when targeting can pick the survey.

## Reading responses into a warehouse

A **data key** gives read-only access:

```
GET https://<SiteUrl>/api/data/<key>/responses?from=2026-10-01&to=2026-10-31
```

Up to 92 days per call; the rows are the same as the CSV export, without customer hashes or tokens. EventBridge events are the alternative for a push feed; see [Closed loop](kb.html?a=closed-loop).

## Several tenants on one stack

A partner serving several clients, or a company with several business units, tags each contact with a **tenant**: bind each client's ingest and data keys to their tenant in *Settings > Other platforms and BI*, and on Amazon Connect set the stack's `TenantAttribute` parameter to the contact attribute that names the unit. The results page gains a tenant filter and a per-tenant table, the CSV and webhooks carry the tenant, and a tenant-bound data key can never read another tenant's responses. Surveys and settings are still shared across the stack; for full isolation (own surveys, own brand, own sign-ins) deploy one stack per client.

## Rendering the survey in your own interface

If you would rather show the questions inside your own chat widget or agent desktop, ask for a link with `POST /api/ingest/<key>/invitations` and either open the hosted page or read the definitions with `GET /api/ingest/<key>/surveys` and post the answers yourself. Signed webhooks tell your application about every completed response. All of it is in the [API reference](kb.html?a=api-reference).

## What stays Connect-specific

The IVR and in-chat surveys (the flow module), low-score Tasks and contact attributes exist only on Amazon Connect. On other platforms the low score is still flagged on the results page and in the event, which is where a Genesys or CRM integration picks it up. The `Provider` stack parameter records which platform feeds the stack; set it to `generic` on a non-Connect deployment.
