// tools/funnels-and-offers/test/emergent-funnels.test.mjs
// The emergence proof: a new funnel is a data row, not code. Forty funnels from forty domains, written only as
// funnel-definition records, all resolve through the one resolver with no change to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFunnelDefinition } from '../read-data/funnel-definition.mjs';

// [id, title, stages, the word that advances a stage]; every one an open string the resolver never enumerates.
const DOMAINS = [
  ['offer-ladder', 'Offer ladder', ['visit', 'offer', 'checkout', 'purchase'], 'advanced'],
  ['masterclass-upsell', 'Masterclass upsell', ['optin', 'watch', 'pitch', 'buy'], 'moved-on'],
  ['book-funnel', 'Book funnel', ['land', 'read-sample', 'buy-book'], 'continued'],
  ['free-guide-to-paid', 'Free guide to paid', ['download', 'nurture', 'upgrade'], 'upgraded'],
  ['trial-to-subscription', 'Trial to subscription', ['signup', 'activate', 'trial', 'paid'], 'converted'],
  ['subscription-upgrade', 'Subscription upgrade', ['basic', 'hit-limit', 'upgrade'], 'upgraded'],
  ['renewal-save', 'Renewal save flow', ['at-risk', 'offer-save', 'renewed'], 'saved'],
  ['dunning-recovery', 'Dunning recovery', ['failed-charge', 'retry', 'recovered'], 'recovered'],
  ['referral', 'Referral funnel', ['invite', 'signup', 'activate'], 'referred'],
  ['webinar', 'Webinar funnel', ['register', 'attend', 'offer', 'buy'], 'attended'],
  ['replay', 'Replay funnel', ['miss-live', 'watch-replay', 'buy'], 'watched'],
  ['email-nurture', 'Email nurture', ['subscribed', 'engaged', 'clicked', 'bought'], 'engaged'],
  ['ad-source-variant', 'Ad source funnel', ['click', 'landing', 'lead', 'sale'], 'progressed'],
  ['product-onboarding', 'Product onboarding', ['signup', 'setup', 'first-value', 'habit'], 'onboarded'],
  ['feature-activation', 'Feature activation', ['discover', 'try', 'adopt'], 'activated'],
  ['usage-expansion', 'Usage expansion', ['adopt', 'expand', 'power-user'], 'expanded'],
  ['churn-risk', 'Churn-risk intervention', ['risk-detected', 'outreach', 'retained'], 'retained'],
  ['support-triage', 'Support triage', ['new', 'triaged', 'in-progress', 'resolved'], 'triaged'],
  ['bug-triage', 'Bug triage', ['reported', 'confirmed', 'fixed', 'verified'], 'confirmed'],
  ['sales-pipeline', 'Sales pipeline', ['lead', 'qualified', 'demo', 'close'], 'qualified'],
  ['recruiting', 'Recruiting pipeline', ['applied', 'screen', 'interview', 'offer', 'accept'], 'advanced'],
  ['admissions', 'Admissions pipeline', ['applied', 'reviewed', 'admitted', 'enrolled'], 'admitted'],
  ['client-onboarding', 'Client onboarding', ['signed', 'kickoff', 'delivered'], 'delivered'],
  ['course-progression', 'Course module progression', ['enrolled', 'module-1', 'module-2', 'completed'], 'progressed'],
  ['coaching-assessment', 'Coaching assessment to plan', ['assess', 'plan', 'commit'], 'committed'],
  ['video-analysis-offer', 'Video upload to offer', ['upload', 'analyze', 'offer', 'buy'], 'analyzed'],
  ['challenge', 'Challenge signup to completion', ['signup', 'day-1', 'finish'], 'finished'],
  ['event-registration', 'Event registration', ['view', 'register', 'attend'], 'registered'],
  ['booking-consult', 'Booking and consult funnel', ['inquire', 'book', 'show-up'], 'booked'],
  ['marketplace-install', 'Marketplace browse to install', ['browse', 'view', 'install'], 'installed'],
  ['creator-publish', 'Creator publish pipeline', ['draft', 'review', 'publish'], 'published'],
  ['content-production', 'Content production workflow', ['idea', 'produce', 'edit', 'ship'], 'produced'],
  ['social-distribution', 'Social distribution funnel', ['created', 'scheduled', 'posted', 'engaged'], 'posted'],
  ['seo-article-signup', 'SEO article to signup', ['visit', 'read', 'signup'], 'read'],
  ['community-engage', 'Community join to engage', ['join', 'onboard', 'engage'], 'onboarded'],
  ['agency-lead-qual', 'Agency lead qualification', ['inbound', 'qualify', 'proposal', 'won'], 'qualified'],
  ['investor-dealflow', 'Investor deal flow', ['sourced', 'screened', 'diligence', 'invested'], 'screened'],
  ['agent-task-lifecycle', 'AI-agent task lifecycle', ['queued', 'running', 'verified', 'shipped'], 'ran'],
  ['product-launch', 'Product launch rollout', ['announce', 'waitlist', 'launch', 'adopt'], 'launched'],
  ['certification-review', 'Certification and compliance review', ['submit', 'review', 'certified'], 'reviewed'],
];

function definitionFor([id, title, stages, token]) {
  return {
    kind: 'funnel-definition',
    id: `funnel:${id}`,
    title,
    stages: stages.map((name, index) => ({
      stage_address: `stage:${id}:${name}`,
      workflow_node_ref: { $ref: `workflow-definition:${id}#${name}` },
      ...(index < stages.length - 1 ? { outcome_edges: [{ outcome_token: token, to_stage: `stage:${id}:${stages[index + 1]}` }] } : {}),
      metric_selectors: [
        { measure_ref: `progression-evaluator:${id}-${name}-entered`, role: 'entered' },
        { measure_ref: `progression-evaluator:${id}-${name}-converted`, role: 'converted' },
      ],
    })),
  };
}

function ownersFor([id, , stages]) {
  const measures = [];
  let entered = 1000;
  for (const name of stages) {
    const converted = Math.round(entered * 0.4);
    measures.push({ id: `${id}-${name}-entered`, value: entered }, { id: `${id}-${name}-converted`, value: converted });
    entered = converted;
  }
  return { workflowNodes: stages.map(name => ({ id: name, label: name.replace(/-/g, ' ') })), measures };
}

test('there are at least 35 distinct funnel domains', () => {
  assert.ok(DOMAINS.length >= 35);
  assert.equal(new Set(DOMAINS.map(domain => domain[0])).size, DOMAINS.length);
});

for (const domain of DOMAINS) {
  test(`resolves the "${domain[1]}" funnel from data alone`, () => {
    const funnel = resolveFunnelDefinition([definitionFor(domain)], ownersFor(domain));
    assert.equal(funnel.stages.length, domain[2].length);
    assert.equal(funnel.title, domain[1]);
    for (const stage of funnel.stages) {
      assert.notEqual(stage.title, stage.stage_address);
      assert.ok(stage.entered > 0);
      // about 40 percent carry through each step; integer rounding drifts a little on deep stages
      assert.ok(stage.conversion_rate > 30 && stage.conversion_rate < 50, `${stage.stage_address}: ${stage.conversion_rate}`);
    }
    assert.equal(funnel.stages[0].outcome_edges[0]?.outcome_token ?? null, domain[2].length > 1 ? domain[3] : null);
  });
}
