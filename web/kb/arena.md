# Feeding Arena

[Arena for Amazon Connect](https://arenaforconnect.com) scores agents on quality, and survey answers are the best quality signal there is. SurveyCX feeds it in two ways; either is enough.

## Through Arena's ingest endpoint (recommended)

1. In Arena's console, open the **Data** button and create an **ingest key**.
2. In SurveyCX, open *Settings > Arena* and paste Arena's site URL with `/api` (for example `https://d1234.cloudfront.net/api`) and the key.
3. Enter an agent ARN and click **Send test score**. Arena's panel for that agent shows a survey score of 5 within a few seconds.

From then on, every completed response with an agent-attributable score is sent to Arena as a `CSAT_RECEIVED` event: the agent's ARN, the contact id, the score on a 1-5 scale and the time. Arena deduplicates per contact, so a retry never double-counts, and the score lands on the agent's day in Arena's points and in its results report.

Company questions (NPS, effort, resolution) are not sent; they are not the agent's doing.

## Through the contact attribute

If your Arena stack already reads Amazon Connect contact records, nothing else is needed: SurveyCX writes the agent score onto the contact as the `csat` attribute, which is the attribute Arena's `CsatAttribute` setting reads by default. Arena then scores it when the contact record arrives.

Use one method or the other. If both are on, Arena's per-contact deduplication keeps the first score it sees.

## Other platforms

On a Genesys or other stack, the ingest endpoint route works unchanged: the agent id sent to Arena is the one your platform reported to SurveyCX, and Arena's linked ids map it to the person.
