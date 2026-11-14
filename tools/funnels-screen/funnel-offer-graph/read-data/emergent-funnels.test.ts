// packages/funnel-offer-graph/read-data/emergent-funnels.test.ts
//
// THE EMERGENCE PROOF (plan F5 + feedback-35-emergent-configs-minimum-per-primitive):
// the stage_address primitive is only a real primitive if NEW funnels are DATA
// ROWS, not code. This test builds 40 funnels across 40 different domains (the
// convergence's full list — offer ladder, trial->sub, dunning, sales pipeline,
// recruiting, admissions, course progression, support triage, AI-agent
// lifecycle, ...) purely as `funnel-definition` DATA and asserts EVERY ONE
// resolves through the SAME `resolveFunnelDefinition` with ZERO engine change,
// producing resolved stages + conversion %. 40 >= 35.

import { describe, expect, it } from 'vitest';
import { resolveFunnelDefinition, type FunnelOwnerRecords } from './funnel-definition';
import { layoutTornado } from './stage-projection';

// Each entry: a domain, its ordered stage names, and its per-stage outcome token
// (the word that advances the funnel). All open strings — the resolver never
// enumerates any of them. This table IS the "40 funnels"; each row becomes a
// funnel-definition record with zero bespoke code.
const DOMAINS: Array<{ id: string; title: string; stages: string[]; token: string }> = [
  { id: 'offer-ladder', title: 'Offer ladder', stages: ['visit', 'offer', 'checkout', 'purchase'], token: 'advanced' },
  { id: 'masterclass-upsell', title: 'Masterclass upsell', stages: ['optin', 'watch', 'pitch', 'buy'], token: 'moved-on' },
  { id: 'book-funnel', title: 'Book funnel', stages: ['land', 'read-sample', 'buy-book'], token: 'continued' },
  { id: 'free-guide-to-paid', title: 'Free guide to paid', stages: ['download', 'nurture', 'upgrade'], token: 'upgraded' },
  { id: 'trial-to-subscription', title: 'Trial to subscription', stages: ['signup', 'activate', 'trial', 'paid'], token: 'converted' },
  { id: 'subscription-upgrade', title: 'Subscription upgrade', stages: ['basic', 'hit-limit', 'upgrade'], token: 'upgraded' },
  { id: 'renewal-save', title: 'Renewal save flow', stages: ['at-risk', 'offer-save', 'renewed'], token: 'saved' },
  { id: 'dunning-recovery', title: 'Dunning recovery', stages: ['failed-charge', 'retry', 'recovered'], token: 'recovered' },
  { id: 'referral', title: 'Referral funnel', stages: ['invite', 'signup', 'activate'], token: 'referred' },
  { id: 'webinar', title: 'Webinar funnel', stages: ['register', 'attend', 'offer', 'buy'], token: 'attended' },
  { id: 'replay', title: 'Replay funnel', stages: ['miss-live', 'watch-replay', 'buy'], token: 'watched' },
  { id: 'email-nurture', title: 'Email nurture', stages: ['subscribed', 'engaged', 'clicked', 'bought'], token: 'engaged' },
  { id: 'ad-source-variant', title: 'Ad source funnel', stages: ['click', 'landing', 'lead', 'sale'], token: 'progressed' },
  { id: 'product-onboarding', title: 'Product onboarding', stages: ['signup', 'setup', 'first-value', 'habit'], token: 'onboarded' },
  { id: 'feature-activation', title: 'Feature activation', stages: ['discover', 'try', 'adopt'], token: 'activated' },
  { id: 'usage-expansion', title: 'Usage expansion', stages: ['adopt', 'expand', 'power-user'], token: 'expanded' },
  { id: 'churn-risk', title: 'Churn-risk intervention', stages: ['risk-detected', 'outreach', 'retained'], token: 'retained' },
  { id: 'support-triage', title: 'Support triage', stages: ['new', 'triaged', 'in-progress', 'resolved'], token: 'triaged' },
  { id: 'bug-triage', title: 'Bug triage', stages: ['reported', 'confirmed', 'fixed', 'verified'], token: 'confirmed' },
  { id: 'sales-pipeline', title: 'Sales pipeline', stages: ['lead', 'qualified', 'demo', 'close'], token: 'qualified' },
  { id: 'recruiting', title: 'Recruiting pipeline', stages: ['applied', 'screen', 'interview', 'offer', 'accept'], token: 'advanced' },
  { id: 'admissions', title: 'Admissions pipeline', stages: ['applied', 'reviewed', 'admitted', 'enrolled'], token: 'admitted' },
  { id: 'client-onboarding', title: 'Client onboarding', stages: ['signed', 'kickoff', 'delivered'], token: 'delivered' },
  { id: 'course-progression', title: 'Course module progression', stages: ['enrolled', 'module-1', 'module-2', 'completed'], token: 'progressed' },
  { id: 'coaching-assessment', title: 'Coaching assessment to plan', stages: ['assess', 'plan', 'commit'], token: 'committed' },
  { id: 'video-analysis-offer', title: 'Video upload to offer', stages: ['upload', 'analyze', 'offer', 'buy'], token: 'analyzed' },
  { id: 'challenge', title: 'Challenge signup to completion', stages: ['signup', 'day-1', 'finish'], token: 'finished' },
  { id: 'event-registration', title: 'Event registration', stages: ['view', 'register', 'attend'], token: 'registered' },
  { id: 'booking-consult', title: 'Booking / consult funnel', stages: ['inquire', 'book', 'show-up'], token: 'booked' },
  { id: 'marketplace-install', title: 'Marketplace browse to install', stages: ['browse', 'view', 'install'], token: 'installed' },
  { id: 'creator-publish', title: 'Creator publish pipeline', stages: ['draft', 'review', 'publish'], token: 'published' },
  { id: 'content-production', title: 'Content production workflow', stages: ['idea', 'produce', 'edit', 'ship'], token: 'produced' },
  { id: 'social-distribution', title: 'Social distribution funnel', stages: ['created', 'scheduled', 'posted', 'engaged'], token: 'posted' },
  { id: 'seo-article-signup', title: 'SEO article to signup', stages: ['visit', 'read', 'signup'], token: 'read' },
  { id: 'community-engage', title: 'Community join to engage', stages: ['join', 'onboard', 'engage'], token: 'onboarded' },
  { id: 'agency-lead-qual', title: 'Agency lead qualification', stages: ['inbound', 'qualify', 'proposal', 'won'], token: 'qualified' },
  { id: 'investor-dealflow', title: 'Investor deal flow', stages: ['sourced', 'screened', 'diligence', 'invested'], token: 'screened' },
  { id: 'agent-task-lifecycle', title: 'AI-agent task lifecycle', stages: ['queued', 'running', 'verified', 'shipped'], token: 'ran' },
  { id: 'product-launch', title: 'Product launch rollout', stages: ['announce', 'waitlist', 'launch', 'adopt'], token: 'launched' },
  { id: 'certification-review', title: 'Certification / compliance review', stages: ['submit', 'review', 'certified'], token: 'reviewed' },
];

/** Build one funnel-definition DATA record for a domain — pure DATA, no code. */
function funnelDefinitionFor(d: { id: string; title: string; stages: string[]; token: string }) {
  return {
    kind: 'funnel-definition',
    id: `funnel:${d.id}`,
    title: d.title,
    stages: d.stages.map((name, i) => ({
      stage_address: `stage:${d.id}:${name}`,
      workflow_node_ref: { $ref: `workflow-definition:${d.id}#${name}` },
      ...(i < d.stages.length - 1
        ? { outcome_edges: [{ outcome_token: d.token, to_stage: `stage:${d.id}:${d.stages[i + 1]}` }] }
        : {}),
      metric_selectors: [
        { measure_ref: `progression-evaluator:${d.id}-${name}-entered`, role: 'entered' },
        { measure_ref: `progression-evaluator:${d.id}-${name}-converted`, role: 'converted' },
      ],
    })),
  };
}

/** Owner records for a domain: workflow node labels + measures (entered halves per step). */
function ownersFor(d: { id: string; stages: string[] }): FunnelOwnerRecords {
  const workflowNodes = d.stages.map((name) => ({ id: name, label: name.replace(/-/g, ' ') }));
  const measures: Array<{ id: string; value: number }> = [];
  let entered = 1000;
  for (const name of d.stages) {
    const converted = Math.round(entered * 0.4);
    measures.push({ id: `${d.id}-${name}-entered`, value: entered });
    measures.push({ id: `${d.id}-${name}-converted`, value: converted });
    entered = converted; // next stage's entered = this stage's converted
  }
  return { workflowNodes, measures };
}

describe('emergent funnels — 40 domains resolve as DATA, zero engine change', () => {
  it('has at least 35 distinct funnel domains', () => {
    expect(DOMAINS.length).toBeGreaterThanOrEqual(35);
    expect(new Set(DOMAINS.map((d) => d.id)).size).toBe(DOMAINS.length);
  });

  it.each(DOMAINS)('resolves + lays out the "$title" funnel from pure DATA', (d) => {
    const def = funnelDefinitionFor(d);
    const owners = ownersFor(d);
    const funnel = resolveFunnelDefinition([def], owners)!;

    // fully resolved: title from workflow node, every stage present
    expect(funnel.stages).toHaveLength(d.stages.length);
    expect(funnel.title).toBe(d.title);
    for (const stage of funnel.stages) {
      expect(stage.title).not.toBe(stage.stage_address); // node label resolved, not the id fallback
      expect(stage.entered).toBeGreaterThan(0);
      // ~40% carry-through per step (integer rounding drifts a little on deep stages)
      expect(stage.conversion_rate).toBeGreaterThan(30);
      expect(stage.conversion_rate).toBeLessThan(50);
    }

    // renders as a narrowing tornado through the shared canvas frame shape
    const { frames, edges } = layoutTornado(funnel.stages);
    expect(frames).toHaveLength(d.stages.length);
    // widths are non-increasing down the funnel (each stage entered <= previous)
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].width).toBeLessThanOrEqual(frames[i - 1].width);
    }
    // one edge between each consecutive stage (via the outcome token)
    expect(edges).toHaveLength(d.stages.length - 1);
    if (edges.length > 0) expect(edges[0].on).toBe(d.token);
  });
});
