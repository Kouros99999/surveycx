# Closed loop: Tasks, attributes and events

A survey is worth running only if somebody acts on the answers. When a response completes, four things happen, each optional and each independent of the others.

## 1. A Task for a low score

If the response is flagged low (see the survey's low-score rule) and *Settings > Closed loop* has a **task flow ID**, SurveyCX opens an Amazon Connect **Task** named *Low survey score: 1.5 of 5 (Ann Lee)* with:

- the survey name, channel and queue,
- every question and answer, including the customer's comment,
- references: *Contact details* (a link to the contact in the Connect console, when `ConnectInstanceUrl` is set) and *Survey response* (a link to the response on the results page),
- the original contact linked as the previous contact, so the agent's history shows it.

The task flow decides who gets it: create a flow that transfers the Task to a supervisor queue (or to the agent's own queue if you want agents to follow up themselves) and paste its ID, the part of its ARN after `contact-flow/`, into Settings. Tasks are routed, worked and reported like any other contact, so follow-up time and completion are visible in Connect's own reports.

If the flow ID is empty, nothing is opened and the low score is still flagged on the results page.

## 2. Scores on the contact

The scores are written onto the original contact as attributes, so they appear in Contact Lens, in the contact record and in anything else that reads attributes:

| Attribute | Value |
|---|---|
| `csat` (name configurable) | the agent-attributable score on a 1-5 scale, or the overall score when no question is agent-attributable |
| `surveycx_five` | the overall 1-5 score |
| `surveycx_nps` | the NPS answer, 0-10, when asked |
| `surveycx_ces` | the effort answer, 1-7, when asked |
| `surveycx_low` | `true` when flagged |
| `surveycx_survey` | the survey id |

The `csat` attribute is the one Arena reads from contact records, so a stack that sends contact records to both products needs no other link.

## 3. An event

Every completed response is put on the account's default EventBridge bus with source `surveycx` and detail type `Survey Completed` or `Survey Completed - Low Score`. The detail carries the contact id, survey, channel, queue, agent, scores and answers. Rules on that bus can post to Slack, open a ticket in your CRM, or land the event in a warehouse; nothing in SurveyCX needs to change.

## 4. Arena

The agent-attributable score goes to Arena through its ingest endpoint. See [Feeding Arena](kb.html?a=arena).

## Did anyone follow up?

Every low score opens a **follow-up** on the response. It is closed in one of three ways:

- the Connect Task opened for it is completed by whoever worked it (the contact record of the Task closes the follow-up and names the agent), or
- a supervisor opens the response on the results page and clicks **Mark followed up**, choosing an outcome (customer recovered, not recovered, could not reach) and an optional note, or
- a partner's application calls `PUT /api/ingest/{key}/responses/{contactId}/followup`.

*Settings > Closed loop* has a **follow-up target** in hours (48 by default). The results page shows how many follow-ups are open, how many are overdue, the median time to follow up and the share done within target, overall and per queue; the queue table and the data API carry the same figures, and the CSV has the status, hours and outcome per response. A follow-up can be dismissed (a prank answer, a wrong number) or reopened.

## Timing

On voice and chat the agent is known only once the contact record arrives, a few minutes after the call. The Task, the attributes and the event go out at completion; the Arena score and the agent on the Task name follow when the record lands, and the attributes are refreshed then as well. Invitations by SMS and email complete whenever the customer answers.
