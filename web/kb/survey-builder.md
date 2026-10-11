# Building a survey

Surveys are built in the console (`console.html`, supervisors only). Keep them short: three to five questions, under a minute, is where completion rates stay high.

## Question types

| Type | Scale | Reported as | Counts for the agent by default |
|---|---|---|---|
| Rating | 1 to 5 | CSAT (% of 4s and 5s, and the average) | Yes |
| NPS | 0 to 10 | NPS (% promoters minus % detractors) | No |
| Effort (CES) | 1 to 7 | average effort | No |
| Yes / no | 1 or 0 | share of yes | No |
| Multiple choice | one of 2 to 9 options | counts per option | – |
| Free text | typed comment | listed with the response | – |

Every scored answer is also brought to a 1-5 scale so surveys with different questions report together, and so Arena receives one scale.

**Counts for the agent.** Tick this on questions about the agent's handling (satisfaction with the service); leave it off for questions about the company (would you recommend us, was it easy, was it resolved). Only agent-attributable scores go into the agent report and to Arena, which keeps agents from being marked down for pricing or policy.

**Driver.** A short label for the report (*Wait time*, *Resolution*). Questions without one are reported under their text.

**Required.** Scored questions are required by default; free text is optional unless you tick it. In chat, a customer skips an optional question by replying with a dash.

## Asking why only when it matters

Any question can carry a rule: *ask only when an earlier question is at most N*. The starter survey asks "What could we have done better?" only when satisfaction was 3 or lower. This keeps happy customers' surveys short and gives you a comment on every poor one.

## Who gets which survey

Each survey has a target:

- **Queues**: the survey applies to contacts handled in any of the listed queues.
- **Contact attribute**: the survey applies when the contact carries the attribute, with a specific value or any value. Set the attribute in your flow (for example `survey = sales`).
- **Neither**: the survey is the default for any contact.

When several surveys match, the attribute match wins, then the queue match, then the default. One survey per contact, ever.

**Deciding in the flow.** Often the inbound flow already knows whether a contact should be surveyed, before any agent is involved. Set the contact attribute `surveycx` to `skip` and no survey runs on any channel for that contact, whatever the targeting; set it to a survey's id to force that survey. The attribute can be set by a *Set contact attributes* block, from CRM data in a Lambda, or by the agent desktop through the Connect API. The same applies to contacts reported through the API: `"attributes": { "surveycx": "skip" }`.

**Channels** limit where the survey runs: voice (IVR), chat (in the chat), SMS and email (invitations with a web link), web. A survey with no SMS or email channel never sends an invitation.

**Sample %** surveys only that share of eligible contacts, chosen deterministically per contact.

## Low score

Each survey sets the low-score rule: any scored answer (or one question) at or below a threshold on the 1-5 scale flags the response and opens a follow-up Task. See [Closed loop](kb.html?a=closed-loop).

## Pausing and preview

A paused survey stops being offered immediately; answers already collected stay. **Preview** opens the web survey exactly as a customer sees it, without saving anything.

## Languages

Set the survey's language tag (`fr-CA`, `es-US`) so the web page is marked correctly for screen readers. Write the questions in that language; one survey per language, targeted by queue or by a `language` contact attribute, is the simplest way to run several.
