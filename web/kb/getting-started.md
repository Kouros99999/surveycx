# Getting started

SurveyCX runs inside your own AWS account. Setting it up takes four steps: launch the stack, connect it to Amazon Connect, build a survey, and watch the first answers arrive.

## 1. Subscribe and launch

Subscribe to **SurveyCX for Amazon Connect** on AWS Marketplace and choose *Set up your account*. The registration page shows a **Launch SurveyCX in CloudFormation** button with your subscription pre-filled.

In the CloudFormation console:

1. Fill in **ConnectInstanceId** (the ID of your Connect instance, the part after `instance/` in its ARN) and **ConnectInstanceUrl** (its access URL). Both can also be set later in the console.
2. Optionally set **AlarmEmail**, **Timezone** (for the send window) and the SMS and email parameters; see [SMS and email invitations](kb.html?a=sms-and-email).
3. Tick all three acknowledgement boxes at the bottom and create the stack. It takes about ten minutes.

The **Outputs** tab then shows `SiteUrl` (the console, results and the hosted survey), `FlowLambdaArn` and `StreamArn`.

## 2. Create a supervisor sign-in

The stack creates a Cognito user pool (`UserPoolId` output). In the Cognito console create a user, add them to the **supervisors** group, and give them a temporary password. Agents who should see their own results go in the **agents** group with the `custom:agentArn` attribute set to their Connect agent ARN. One command does all of it from your Connect directory:

```
node lambda/sync-users.js <stack name> --instance <connect instance id> --dry-run
node lambda/sync-users.js <stack name> --instance <connect instance id>
```

Users whose Connect security profile is named supervisor, admin or manager land in the supervisors group; everyone else becomes an agent. New users get a temporary password by email. See [Settings reference](kb.html?a=settings-reference) for using your own identity provider instead.

## 3. Connect the survey to your flows

Voice and chat surveys run in the **disconnect flow**:

1. In the Connect console, open *Flows* under your instance, choose *AWS Lambda*, and add the function from the `FlowLambdaArn` output.
2. On your computer run `node lambda/flow-module.js <FlowLambdaArn>` from the [repository](https://github.com/Kouros99999/surveycx), or download the module file from the release. Import it as a **flow module** (Routing > Flows > Modules > Create > Import).
3. Create a small flow that invokes the module and ends with Disconnect, publish it, and in each inbound flow you want surveyed add a **Set disconnect flow** block pointing at it.

Details and what the customer hears are in [Surveys on voice and chat](kb.html?a=voice-and-chat).

For agent attribution and SMS/email invitations, send **contact records** to the stack: in the Connect console under *Data streaming*, enable contact trace records and choose the Kinesis stream from the `StreamArn` output.

## 4. Build your first survey

Open `<SiteUrl>/console.html` and sign in. A starter survey is ready: satisfaction, resolved, effort, recommend, and an open question that only appears after a low score. Edit it or add one per queue; see [Building a survey](kb.html?a=survey-builder).

## 5. Watch the answers

`<SiteUrl>/results.html` shows scores as soon as the first survey completes. A low score opens a Task in Connect if you set a task flow in Settings; see [Closed loop](kb.html?a=closed-loop).

## Pilots without Marketplace

The same template deploys without a subscription: leave the three `Marketplace…` parameters empty and nothing is reported or billed.
