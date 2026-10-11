# Verbatim analysis: sentiment and themes

Scores tell you *how* customers felt; their own words tell you *why*. With verbatim analysis on, SurveyCX reads every free-text answer so a supervisor does not have to.

## What you get

- **Sentiment on every comment.** As a response completes, its free-text answers are scored positive, negative, neutral or mixed (Amazon Comprehend). The results page shows a sentiment pill beside each comment and a positive/negative bar for the period; the agent and queue tables carry comment counts. The sentiment travels with the response in webhooks, EventBridge events, the data API and the CSV.
- **Themes with example quotes.** Once a day, the comments of the trailing 30 days are grouped into up to eight themes a supervisor can act on ("Long wait before answer", "Issue not resolved", "Friendly, fast help"), each with a count, a sentiment and up to three quotes (Amazon Bedrock). The *What customers say* card on the results page shows them, overall or per survey; the data API's report carries them as `themes`.

## Privacy

Before any text leaves the table it is redacted: email addresses, phone numbers, card and account numbers, government id patterns, long digit runs, links and "my name is …" self-identification are replaced with placeholders. The stored answer is untouched; only the copy sent to the AI service is redacted. Both services run inside your AWS account and region; nothing goes to SurveyCX or any third party. Amazon Comprehend and Bedrock do not use your inputs to train models.

## Turning it on

Deploy or update the stack with **VerbatimAnalysis = enabled**. Theme extraction needs access to the model named in **ThemesModelId** (default: Claude Haiku 4.5 through a cross-region inference profile) in the Bedrock console under *Model access*; without it the sentiment still works and themes stay empty. The console's *Verbatim analysis* setting lets a supervisor pause sentiment scoring without redeploying.

Costs are AWS's: roughly a tenth of a cent per comment for sentiment, and a few cents per day per survey for themes.

## Reading it well

Themes are only as good as the comments: a survey that asks "What could we have done better?" only after a low score will produce negative themes by design, which is the point. Add an optional open question for everyone if you also want to hear what works. A theme's count is the model's grouping, not a precise tally; use it to decide where to look, then open the responses behind it.
