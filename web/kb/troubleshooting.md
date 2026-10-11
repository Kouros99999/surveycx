# Troubleshooting

## The caller hears nothing after the agent hangs up

- The inbound flow has no **Set disconnect flow** block, or it is placed after the queue transfer. It must run before the contact is queued.
- The Lambda is not added to the instance (*Flows > AWS Lambda*). The module import shows the block in error.
- The customer hung up first. The disconnect flow only runs for a customer who is still on the line.
- Check the `surveycx-flow-errors` alarm and the function's CloudWatch log; a log line with `reason` says why the contact was not eligible (`no survey for this contact`, `not sampled`, `already surveyed`).

## No survey matches the contact

Targeting is by queue **name** as Connect reports it, and by contact attribute. Open the survey and compare the queue list with the queue the contact was in; or remove the target to make the survey the default.

## Responses show no agent

Contact records are not reaching the stack. In the Connect console under *Data streaming*, check that contact trace records go to the `StreamArn` stream; the `surveycx-ingest-errors` alarm and the ingest function's log show records arriving. Attribution lands a few minutes after the call.

## No SMS or email invitations

In order: the survey must have the SMS or email channel ticked; the contact must carry a phone number (voice) or the email attribute; the customer must not be opted out or inside the frequency cap; the time must be inside the send window (otherwise it is queued for the morning); `SmsOrigination` or `EmailFrom` must be set. The response row's status stays *offered* while queued; a failed send shows the error when you open the response. Common errors: the SES account is still in the sandbox, the number is not registered for the destination country, the origination identity is wrong.

## The email arrives but the one-click rating does nothing

The link opens `survey.html#<token>&a=<n>`; some mail clients strip fragments. The customer can still open the full survey from the link below the buttons.

## A customer says they never asked for surveys

Open *Settings > Privacy requests*, enter their number or email, and delete: their responses are removed and they are never invited again.

## Arena shows no survey scores

Use **Send test score** in *Settings > Arena*. A 401 means the key is wrong or revoked; a 404 means the URL lacks `/api`; a timeout means the Arena site URL is unreachable from Lambda (it must be the public CloudFront URL). Scores only go for agent-attributable questions and only once the agent is known (after the contact record arrives).

## Low scores open no Task

The task flow ID must be set in *Settings > Closed loop* and the stack must know the instance (`ConnectInstanceId` or the console setting). The API function's log shows `closeLoop` lines with the error Connect returned (usually the flow ID is wrong or the flow is not published).

## Getting help

Email [support@ekpk.com](mailto:support@ekpk.com) with the stack name, region and the time of the contact. Nothing in your account is visible to us, so the CloudWatch log lines help.
