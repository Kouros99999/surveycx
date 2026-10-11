# SMS and email invitations

Customers who did not get a survey in the call or chat can be invited by SMS or email to a hosted web survey. Invitations are driven by **contact records**: when a contact ends, the stack reads the customer's phone number (the contact's endpoint) or email (a contact attribute, `email` by default) and queues an invitation if the survey, the rules and the customer allow it.

## Setting up sending

**SMS** goes through AWS End User Messaging (the service behind Amazon Connect's outbound SMS). You need a phone number, sender ID or pool there, with the registrations your country requires (10DLC in the US). Put its number or ARN in the stack's `SmsOrigination` parameter or in *Settings > Invitations*. To honour **STOP** replies automatically, enable two-way SMS on that number with an SNS topic as the destination and pass the topic ARN as `InboundSmsTopicArn`.

**Email** goes through Amazon SES. Verify a sender address or domain in SES, move the account out of the SES sandbox if it still is, and put the address in `EmailFrom` or in the console. The email carries a one-click 1-5 rating; clicking a number saves it and opens the rest of the survey.

Leave either empty to skip that channel.

## The rules

All of these are in *Settings > Invitations*:

- **Frequency cap** (default 30 days): the same phone number or email is not invited again within this period, whatever the queue. Set 0 to disable.
- **Send window** (default 8:00 to 21:00 in the stack's time zone): nothing is sent outside it; invitations wait for the next morning. The window is in your centre's time zone, not the customer's, so set it conservatively if you serve several time zones. Quiet-hour rules for texting are the law in many places.
- **Reminder** (default none): one reminder after N hours if the survey is still unanswered, inside the send window. Never more than one.
- **Sampling** is per survey, in the builder.
- **Opt-out**: a STOP reply, the *I'd rather not receive surveys* link on the survey page, or a privacy deletion in the console stops all future invitations to that number or address.

Phone numbers and email addresses are stored only as hashes; the queued message keeps the address until it is sent, then drops it.

## The messages

Templates are editable in the console. `{link}` is the survey link and `{brand}` the company name from *Settings > Brand*. Keep "Reply STOP to opt out" in the SMS; carriers expect it. The survey link is valid for 14 days.

## What the customer sees

The web survey is a single page with one question at a time, large touch targets, keyboard operation and screen-reader labels (WCAG 2.1 AA). It shows your brand name, colour and logo. A finished survey cannot be answered twice; a second visit shows a thank-you.

## Sending from another platform

If your contacts do not come from Amazon Connect, post finished contacts to the ingest endpoint and the same rules and messages apply. See [Genesys and other platforms](kb.html?a=other-platforms).
