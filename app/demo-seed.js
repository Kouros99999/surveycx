/* Demo data: a few surveys and ~400 responses over 45 days. Used by the dev server (Node) and the website demo (browser). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../lambda/src/surveycx-core.js'));
  else root.SurveyCXSeed = factory(root.SurveyCX);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';
  const AGENTS = [['ann', 'Ann Lee', 'Billing'], ['bob', 'Bob Reyes', 'Billing'], ['cat', 'Catherine Oduya', 'Support'], ['dan', 'Dan Novak', 'Support'], ['eve', 'Eve Martins', 'Sales'], ['fay', 'Fay Chen', 'Support']];
  const COMMENTS = ['Waited far too long before anyone picked up.', 'Sorted in two minutes, thank you.', 'The agent was polite but could not fix the billing error.', 'Had to repeat my account number three times.', 'Great help, clear explanation.', 'Transferred twice.', 'Still not resolved.', 'Very friendly and fast.'];
  let seedN = 7; const rnd = () => { seedN = (seedN * 9301 + 49297) % 233280; return seedN / 233280; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  async function seed(store, days) {
    days = days || 45;
    const def = S.normalizeSurvey(Object.assign({ id: 'default', target: { queues: [], channels: S.CHANNELS } }, S.DEFAULT_SURVEY));
    const sales = S.normalizeSurvey({ id: 'sales', name: 'Sales follow-up', target: { queues: ['Sales'], channels: ['sms', 'email', 'web'] }, questions: [{ id: 'csat', type: 'rating', text: 'How satisfied were you with your sales conversation today?', driver: 'Overall satisfaction' }, { id: 'reason', type: 'choice', text: 'What was the call mainly about?', driver: 'Topic', options: ['New plan', 'Upgrade', 'Pricing question', 'Other'] }, { id: 'nps', type: 'nps', text: 'How likely are you to recommend us?', driver: 'Recommend' }], lowScore: { enabled: true, threshold: 2 } });
    await store.putSurvey(def); await store.putSurvey(sales);
    await store.putSettings({ brand: { name: 'Northwind Utilities', accent: '#0f766e' }, closedLoop: { enabled: true, taskFlowId: 'demo-flow', attribute: 'csat' }, delivery: { reminderHours: 24 } });
    const now = Date.now();
    for (let d = days; d >= 0; d--) {
      const n = 5 + Math.floor(rnd() * 8);
      for (let i = 0; i < n; i++) {
        const [u, name, queue] = pick(AGENTS); const at = new Date(now - d * 86400000 - Math.floor(rnd() * 36000000) - 3600000 * 6).toISOString();
        const survey = queue === 'Sales' ? sales : def, channel = pick(queue === 'Sales' ? ['sms', 'email'] : ['voice', 'voice', 'chat', 'sms']);
        const id = `demo-${d}-${i}`, skill = u === 'dan' ? 0.55 : u === 'ann' ? 0.9 : 0.78;
        const status = rnd() < 0.35 ? 'offered' : rnd() < 0.15 ? 'started' : 'completed';
        const row = { contactId: id, surveyId: survey.id, channel, status, startedAt: at, agentArn: 'arn:aws:connect:us-east-1:111122223333:instance/i/agent/' + u, agentName: name, queue, answers: {}, platform: 'connect', token: 't' + id };
        if (status !== 'offered') {
          const good = rnd() < skill;
          const csat = good ? (rnd() < 0.6 ? 5 : 4) : (rnd() < 0.5 ? 2 : rnd() < 0.5 ? 1 : 3);
          row.answers.csat = csat;
          if (status === 'completed') {
            if (survey === def) { row.answers.resolved = good ? 1 : rnd() < 0.4 ? 1 : 0; row.answers.effort = good ? 5 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 4); row.answers.nps = good ? 7 + Math.floor(rnd() * 4) : Math.floor(rnd() * 7); if (csat <= 3 && channel !== 'voice') row.answers.why = pick(COMMENTS); }
            else { row.answers.reason = 1 + Math.floor(rnd() * 4); row.answers.nps = good ? 8 + Math.floor(rnd() * 3) : Math.floor(rnd() * 7); }
            row.completedAt = new Date(Date.parse(at) + 120000).toISOString(); row.scores = S.scoreResponse(survey, row.answers);
            if (row.scores.low) { row.followUp = S.openFollowUp(row.completedAt); if (rnd() < 0.6) row.followUp = S.closeFollowUp(row.followUp, { status: 'done', by: 'Sam Supervisor', outcome: rnd() < 0.7 ? 'recovered' : 'not-recovered' }, new Date(Date.parse(row.completedAt) + Math.floor(rnd() * 90) * 3600000).toISOString()); }
            if (row.answers.why) row.sentiment = { label: /thank|great|friendly|clear/i.test(row.answers.why) ? 'positive' : 'negative', positive: 0.1, negative: 0.8, neutral: 0.1, mixed: 0 };
          }
        }
        await store.putResponse(row);
        await store.touchAgent(row.agentArn, name, queue, at);
      }
    }
    if (store.putThemes) await store.putThemes('*', new Date(now).toISOString().slice(0, 10), { comments: 38, from: new Date(now - 30 * 86400000).toISOString().slice(0, 10), to: new Date(now).toISOString().slice(0, 10), themes: [{ name: 'Long wait before answer', sentiment: 'negative', count: 14, examples: ['Waited far too long before anyone picked up.'] }, { name: 'Issue not resolved', sentiment: 'negative', count: 9, examples: ['Still not resolved.', 'The agent was polite but could not fix the billing error.'] }, { name: 'Repeating account details', sentiment: 'negative', count: 6, examples: ['Had to repeat my account number three times.'] }, { name: 'Friendly, fast help', sentiment: 'positive', count: 9, examples: ['Great help, clear explanation.', 'Very friendly and fast.'] }] });
    await store.putResponse({ contactId: 'demo', surveyId: 'default', channel: 'sms', status: 'offered', startedAt: new Date(now).toISOString(), answers: {}, agentArn: 'arn:aws:connect:us-east-1:111122223333:instance/i/agent/ann', agentName: 'Ann Lee', queue: 'Billing', token: 'demo' });
    await store.putToken('demo', 'demo', now + 86400000 * 14);
  }
  return { seed };
});
