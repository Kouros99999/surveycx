# Security and data

This page is written for the person who has to approve SurveyCX for a contact centre.

## Where it runs

SurveyCX is a CloudFormation stack in **your** AWS account: Lambda functions, one DynamoDB table, a Kinesis stream, an HTTP API, a private S3 bucket behind CloudFront, a Cognito user pool, EventBridge rules and CloudWatch alarms. EKPK LLC has no access to the account, the table or the answers. The template is public on [GitHub](https://github.com/Kouros99999/surveycx) and every release ships with checksums.

## What leaves the account

- One number a day to AWS Marketplace: how many survey responses completed, for billing. Nothing else about the contact, the customer or the agent.
- Survey scores to Arena, only if you configure the Arena feed, and only to the Arena stack you point it at (normally in the same account).
- SMS and email through AWS End User Messaging and Amazon SES, in your account.

No telemetry, no phone-home, no third-party services.

## What is stored

Per response: the contact id, survey id, agent id and name, queue, channel, status, timestamps, the answers (including free text) and the scores. Phone numbers and email addresses are stored **only as SHA-256 hashes**, used for the frequency cap and the opt-out list; the queued invitation holds the address until it is sent, for at most a day. The web survey link is a random token with a 14-day life.

Free-text answers may contain whatever the customer typed. SurveyCX does not send them to any AI service. Redaction before any future AI processing is a design rule for this product.

## Retention and deletion

- Responses expire after **RetentionDays** (default 400) through DynamoDB TTL.
- *Settings > Privacy requests* deletes every response for a phone number, email or contact id and adds the customer to the opt-out list, for GDPR and CCPA requests.
- Deleting the stack deletes the table. Point-in-time recovery keeps 35 days of backups while the stack exists.

## Access

- Supervisors and agents sign in through Cognito (hosted UI, authorization code with PKCE, 12-character passwords). Supervisors build surveys, change settings and see everything; agents see only their own results. Federate your identity provider to the pool, or deploy with `AuthMode=external` and your OIDC issuer.
- The web survey, the ingest endpoints and the data endpoint are reachable without sign-in; the token or key in the URL is the credential. Tokens and keys are random, keys are shown once and can be revoked, and ingest keys cannot read.
- Every setting change and deletion is logged to CloudWatch with the user who made it.

## Encryption

DynamoDB, Kinesis and S3 are encrypted at rest with AWS-managed keys. All traffic is HTTPS; the site sends HSTS and a content security policy.

## Compliance notes

- **TCPA / 10DLC**: SMS invitations are transactional messages to customers who just contacted you. SurveyCX enforces a send window, a frequency cap, at most one reminder and STOP handling; registering your number and keeping consent records remain your responsibility.
- **CAN-SPAM**: email invitations are transactional; the survey page carries an opt-out link.
- **GDPR / CCPA**: data minimisation (hashed addresses), retention limits, deletion on request, and data that never leaves your account and region.
- **HIPAA**: the stack uses HIPAA-eligible AWS services; avoid free-text questions that invite health details, or disable free text for those queues.
- **Accessibility**: the web survey follows WCAG 2.1 AA.
