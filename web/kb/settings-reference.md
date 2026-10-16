# Settings reference

## Stack parameters (CloudFormation)

| Parameter | Default | What it does |
|---|---|---|
| `ConnectInstanceId` | empty | Your Connect instance ID. Needed for contact attributes and low-score Tasks. Can be set later in the console. |
| `ConnectInstanceUrl` | empty | The instance's access URL, for links from Tasks to the contact and to allow the agent workspace to frame the pages. |
| `ShardCount` | 1 | Shards on the contact record stream. |
| `SmsOrigination` | empty | AWS End User Messaging number, sender ID or pool ARN for SMS. Empty disables SMS unless set in the console. |
| `InboundSmsTopicArn` | empty | SNS topic that receives inbound SMS, so STOP replies opt customers out. |
| `EmailFrom` | empty | SES-verified sender for email invitations. Empty disables email unless set in the console. |
| `EmailAttribute` | `email` | Contact attribute holding the customer's email. |
| `VerbatimAnalysis`, `ThemesModelId` | `disabled`, Claude Haiku 4.5 profile | Sentiment on comments and daily themes; see [Verbatim analysis](kb.html?a=verbatim-analysis). |
| `TenantAttribute` | empty | Contact attribute naming the tenant or business unit, for per-tenant reporting. |
| `Timezone` | `UTC` | IANA zone for the send window and day boundaries. |
| `RetentionDays` | 400 | Days responses are kept. |
| `Provider` | `connect` | `connect` or `generic` (another platform through the ingest endpoint). |
| `Partner` | empty | A partner or reseller tag, recorded on the stack's health response. |
| `AuthMode`, `JwtIssuer`, `JwtAudience` | `cognito` | Use the stack's user pool, or your own OIDC provider. |
| `AllowedOrigin` | `*` | CORS origin for the API. |
| `MarketplaceTrialDays`, `MarketplaceTrialResponses` | 30, 500 | The free trial. |
| `MarketplaceProductCode`, `MarketplaceLicenseArn`, `MarketplaceCustomerAccountId` | empty | Filled in by the Marketplace launch link. Leave empty for pilots. |
| `SiteArchiveUrl` | the release's site.zip | What the stack installs into its site bucket. |
| `AlarmEmail` | empty | Receives the CloudWatch alarms. |

## Console settings

**Closed loop**: open a Task on a low score (on/off), task flow ID, Connect instance ID, the attribute name for the agent score (`csat`), follow-up target in hours (48).

**Invitations**: frequency cap in days, send window hours, reminder hours, SMS origination identity, email sender, SMS text, email subject and text.

**Arena**: Arena site URL (with `/api`) and ingest key; a test button.

**Brand**: company name, accent colour and logo URL shown on the web survey and in emails.

**Other platforms and BI**: ingest keys and data keys, with labels and expiry; revoke any time.

**Privacy requests**: delete by phone, email or contact id.

## Per survey (builder)

Name, status, language tag, target queues or attribute, channels, sample %, intro, questions (type, text, driver, counts for the agent, required, options, skip rule), closing text, low-score rule (which question, threshold).

## Sign-in groups

`supervisors` may do everything. `agents` see their own results; their Cognito user needs `custom:agentArn` set to the Connect agent ARN (or the platform id reported through the ingest endpoint).

## Alarms

`surveycx-flow-errors` (the survey Lambda fails: customers hear no survey), `surveycx-ingest-errors` (contact records fail: no invitations, no agent attribution), `surveycx-api-errors`, `surveycx-metering-errors` (on Marketplace). All publish to the `AlarmTopicArn` output.
