# Surveys on voice and chat

On voice and chat the survey runs inside Amazon Connect, in the **disconnect flow**: the flow that runs for the customer after the agent leaves the contact. No transfer, no outbound call, no survey number.

## The flow module

The stack outputs `FlowLambdaArn`. Generate the module with:

```
node lambda/flow-module.js <FlowLambdaArn>
```

This writes `surveycx-flow-module.json`. Before importing it, add the Lambda to your instance (Connect console > your instance > *Flows* > *AWS Lambda* > add function), or the import will not resolve it. Then import the file as a flow module.

The module does the following:

1. Invokes the Lambda with `action=start`. The Lambda picks the survey for the contact (queue, attributes, channel, sampling) and answers with the intro and the first prompt, or says the contact is not eligible.
2. Plays the intro and the prompt, collects the customer's input (keypad on voice, a typed reply on chat), and sends it back with `action=answer`.
3. Repeats with the next prompt until the Lambda says the survey is done, then plays the closing text and ends.

An invalid answer is re-asked once with the prompt repeated. Ten seconds of silence ends the survey politely. Anything the customer answered before dropping is kept as a partial response.

## Wiring it in

1. Create a flow named, say, *SurveyCX disconnect*: Entry > **Invoke module** (SurveyCX survey) > **Disconnect**. Publish it.
2. In every inbound flow you want surveyed, add **Set disconnect flow** pointing at it, before the contact reaches a queue.
3. For chat, the same flow works. If you start chats from your own website with the Connect chat widget or `StartChatContact`, enable *DisconnectOnCustomerExit* so the disconnect flow runs when the agent ends the chat.

Test with a call: have the agent hang up first; the customer should hear the intro within a second.

## What the customer hears and sees

Prompts are generated from the question text:

- Rating: "… Press 1 for very dissatisfied up to 5 for very satisfied."
- NPS: "… Press a number from 0 to 9, or press 1 then 0 for 10."
- Effort: "… Press 1 for very difficult up to 7 for very easy."
- Yes/no: "… Press 1 for yes or 0 for no."
- Multiple choice: "… Press 1 for …, press 2 for …"

In chat the same questions ask the customer to *reply with a number*, and a free-text question invites a typed answer (a dash skips it). On voice, **free-text questions are skipped**; spoken comments with transcription are on the roadmap.

The intro and closing text are set per survey. Connect reads them with the voice your flow uses; for another language set the flow's language and voice before invoking the module.

## Agent attribution

The disconnect flow does not know which agent handled the contact, so the response is stored first and the **contact record**, which arrives a little later on the stream, fills in the agent and queue. Until then a fresh response shows no agent on the results page. If you do not send contact records, voice and chat responses stay unattributed.

## Chat surveys from a web link instead

If you prefer not to survey inside the chat, untick *In chat* on the survey and tick *Email* or *SMS*: customers whose contact carries an email attribute or phone number get a link after the chat ends. See [SMS and email invitations](kb.html?a=sms-and-email).
