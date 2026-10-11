# Billing and the free trial

SurveyCX is billed through AWS Marketplace on your AWS bill, **per completed survey response**.

## What counts

A response counts when the customer finishes the survey: every required question answered, on any channel. Surveys that were offered and ignored, started and abandoned, or sent and never opened cost nothing. Answers posted from another platform through the ingest endpoint count the same way.

## How usage is reported

Once a day, after local midnight, a function in your stack counts the responses completed the previous day and reports that one number to AWS Marketplace against your subscription. The report is idempotent: a retry never double-bills. If a report fails, the `surveycx-metering-errors` alarm fires and the next successful run reports the missed day.

The day boundary follows the stack's `Timezone` parameter.

## Free trial

For 30 days from the first report, the first 500 completed responses each day are free (`MarketplaceTrialDays` and `MarketplaceTrialResponses`). Both counts are stored in the table so you can see what was billed.

## What else you pay AWS for

The stack's own resources at AWS rates: a few dollars a month for a typical centre (Lambda, DynamoDB on demand, one Kinesis shard, CloudFront). SMS and email are billed per message by AWS End User Messaging and SES.

## Pilots and direct deals

Deploy the same template with the three `Marketplace…` parameters empty. Nothing is reported or billed; the daily count is still recorded in the table.
