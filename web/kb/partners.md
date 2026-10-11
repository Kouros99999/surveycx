# Partners: one stack per client

A partner or reseller who serves several clients has two ways to run SurveyCX. The choice is about data, not features.

| | One stack, tenant keys | One stack per client |
|---|---|---|
| Client data | One table; separated by tenant-bound keys | Separate AWS stack, table and bucket per client |
| Surveys, brand, settings | Shared across tenants | Per client |
| Sign-ins | One user pool | One pool per client (or the client's own IdP) |
| Reports | Per tenant through bound data keys and the tenant filter | Per client by nature; roll up through each client's data key |
| Cost | One set of resources | A few dollars a month per stack |
| When | Internal business units, low-sensitivity programmes | Clients whose data must not share storage: most regulated or enterprise clients |

Where client data cannot be shared, run **one stack per client**. The provisioner makes that a single command.

## Provisioning a client

From the [repository](https://github.com/Kouros99999/surveycx), with AWS credentials for the account the stack belongs in (the partner's account, one per client, or the client's own):

```
node lambda/provision.js acme-surveys --version 0.1.0 --partner VeriCX --provider generic \
  --brand "Acme Insurance" --accent "#1d4ed8" --logo https://acme.example/logo.png \
  --webhook https://vericx.example/hooks/acme --secret <random> --timezone America/New_York --alarm-email ops@vericx.example
```

It deploys the published release, waits for CloudFront, writes the brand and webhook into the stack, adds the starter survey, creates the client's first **ingest key** and **data key**, and prints the site URL and both keys once. Run it again with new options to update parameters; existing keys and settings are kept. `--delete` removes the stack and everything in it.

For a client on Amazon Connect add `--connect-instance <id> --connect-url https://<alias>.my.connect.aws`; the output then includes the flow Lambda ARN for the flow module and the stream ARN for contact records. For any other platform, the partner's integration posts finished contacts to that stack's ingest endpoint; see the [API reference](kb.html?a=api-reference).

## Billing per client

- **AWS Marketplace:** the partner subscribes once and every client stack is launched with the same `MarketplaceLicenseArn` and `MarketplaceCustomerAccountId` (`--license-arn`, `--customer-account`, `--product-code`). Each stack reports its own completed responses nightly and Marketplace adds them up on one bill. To bill clients individually, each client subscribes themselves, or the partner uses a Marketplace channel-partner private offer per client.
- **Direct:** leave the Marketplace options out. Each stack still counts completed responses per day in its table; the partner reads them per stack with the data key's report (`overall.n` per period) for its own invoicing.

## Isolation checklist

Each client stack has its own DynamoDB table (encrypted, point-in-time recovery), S3 bucket, CloudFront distribution, API, Cognito pool, keys and CloudWatch logs. Nothing in one stack can read another. Deleting a client's stack deletes the client's data. A client who wants their data in their own AWS account simply has the stack deployed there; the partner keeps the ingest and data keys.
