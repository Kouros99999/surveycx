# Reading the results

`results.html` answers three questions: how are we doing, where is it going wrong, and who needs a conversation.

## The headline and tiles

The sentence at the top compares the chosen period with the one before it: *130 customers answered between … CSAT 76% (+6 points), NPS 9, 30 low scores flagged.* The tiles show completed responses, completion rate (completed of offered), CSAT as the share of 4s and 5s and as an average, NPS, average effort and the number of low scores.

**CSAT %** is top-two-box: the share of rating answers that were 4 or 5. **NPS** is promoters (9-10) minus detractors (0-6), as a whole number from -100 to 100. **Effort** is the average on the 1-7 scale.

## Filters

Period (7, 30, 90 days or custom, up to 92 days), survey, queue, agent, tenant (shown when responses carry one), and *low scores only*. Every table and the export follow the filters; a *By tenant* table appears when tenants are in use.

## Completion

Offered, started and completed, overall and per channel. "Offered" counts every contact a survey was played, shown or sent to. A low completion on SMS with a high one on voice usually means the SMS arrives too late or outside hours; see the send window in [SMS and email invitations](kb.html?a=sms-and-email).

## By agent, queue, driver, channel

Each table shows responses, CSAT %, CSAT average, NPS, effort and the count of low scores. The **driver** table breaks results down by question (using the driver label from the builder), so *Wait time* at 3.1 against *Resolution* at 4.4 tells you where to look. Multiple-choice questions list the count per option.

Only agent-attributable questions go into the agent table; a company question such as *would you recommend us* is in the driver table but does not move an agent's score.

## Responses

Every response in the period, newest first, with status (done, low, offered, started), the overall score and the first comment. **Open** shows the full response: every question and answer, the scores, the contact id and a link to the contact in Amazon Connect. Supervisors can delete a response from here. The link `results.html#contact=<id>` opens a response directly; low-score Tasks carry it.

## Export and print

**Export CSV** downloads the filtered responses with one column per question, ready for a spreadsheet or BI tool. For a nightly feed into a warehouse use a data key instead; see [Genesys and other platforms](kb.html?a=other-platforms). **Print** produces a clean report without the filters.

## What agents see

A user in the **agents** group with `custom:agentArn` set opens the same page and sees only their own responses and scores, including customers' comments. They cannot export or delete.
