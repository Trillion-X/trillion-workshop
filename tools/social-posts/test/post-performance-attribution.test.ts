import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { readPostPerformanceAttributionRows } from '../read-data/post-performance-attribution.ts';

describe('readPostPerformanceAttributionRows', () => {
  const publishedStatus = {
    address: 'publish-status:one',
    role: 'accepted_publish_statuses',
    payload: {
      kind: 'generic.action-state-event',
      state: 'published',
      intent_id: 'intent:one',
      observed_at: '2026-09-20T12:00:00Z',
      external_result: {
        service_connection_ref: 'connection:instagram',
        remote_content_id: 'remote:one',
        remote_url: 'https://social.example/p/one',
      },
    },
  };

  it('joins the latest actual provider metrics to the exact published status and UTM visits', () => {
    const results = readPostPerformanceAttributionRows([
      publishedStatus,
      {
        address: 'observation:one',
        role: 'observations',
        payload: {
          kind: 'content-analytics.observation',
          observation_id: 'observation:one',
          source_id: 'post-source:one',
          metrics: { views: 712, shares: 9 },
          observed_at: '2026-09-22T12:00:00Z',
          evidence: { publish_status_ref: { address: 'publish-status:one' } },
        },
      },
      {
        role: 'attribution_visits',
        payload: { kind: 'traffic-observer-fact', observer_id: 'visitor:one', projectId: 'project:one', signals: { utm_content: 'intent:one' } },
      },
      {
        role: 'attribution_visits',
        payload: { kind: 'traffic-observer-fact', observer_id: 'visitor:two', projectId: 'project:one', signals: { utm_content: 'remote:one' } },
      },
      {
        role: 'attribution_conversions',
        payload: { kind: 'traffic-conversion', observer_id: 'visitor:one', projectId: 'project:one', value: 45 },
      },
      {
        role: 'attribution_visits',
        payload: { kind: 'traffic-observer-fact', observer_id: 'unrelated', projectId: 'project:one', signals: { utm_campaign: 'intent:one', utm_content: 'another-post' } },
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      role: 'post_performance',
      payload: {
        remote_content_id: 'remote:one',
        remote_url: 'https://social.example/p/one',
        metrics: { views: 712, shares: 9 },
        attribution: { visits: 2, conversions: 1, value: 45 },
        evidence: { publish_status_ref: 'publish-status:one', metric_observation_present: true },
      },
    });
  });

  it('joins the exact publisher-emitted intent and destination UTM token to that post', () => {
    const status = {
      ...publishedStatus,
      payload: { ...publishedStatus.payload, target_id: 'youtube' },
    };
    const results = readPostPerformanceAttributionRows([
      status,
      {
        role: 'attribution_visits',
        payload: {
          kind: 'traffic-observer-fact',
          observer_id: 'visitor:from-published-link',
          projectId: 'project:one',
          signals: { utm_content: 'intent:one::youtube' },
        },
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toMatchObject({ attribution: { visits: 1 } });
  });

  it('does not turn missing metrics, visits, or conversions into guessed zeros', () => {
    const results = readPostPerformanceAttributionRows([
      publishedStatus,
      {
        role: 'attribution_visits',
        payload: { kind: 'traffic-observer-fact', observer_id: 'visitor:one', signals: { utm_content: 'intent:one' } },
      },
    ]);

    expect(results[0]?.payload).toMatchObject({ metrics: {}, attribution: { visits: 1 } });
    expect((results[0]?.payload as { attribution: object }).attribution).not.toHaveProperty('conversions');
    expect((results[0]?.payload as { attribution: object }).attribution).not.toHaveProperty('value');
  });

  it('requires a published status and exact identity match', () => {
    const results = readPostPerformanceAttributionRows([
      {
        ...publishedStatus,
        payload: { ...(publishedStatus.payload), state: 'scheduled' },
      },
      {
        role: 'attribution_visits',
        payload: { kind: 'traffic-observer-fact', observer_id: 'visitor:one', signals: { utm_source: 'social', utm_campaign: 'intent:one' } },
      },
    ]);

    expect(results).toEqual([]);
  });

  it('fails closed when one UTM token could name posts on multiple channels', () => {
    const results = readPostPerformanceAttributionRows([
      publishedStatus,
      {
        address: 'publish-status:two',
        role: 'accepted_publish_statuses',
        payload: {
          kind: 'generic.action-state-event',
          state: 'published',
          intent_id: 'intent:one',
          external_result: {
            service_connection_ref: 'connection:youtube',
            remote_content_id: 'remote:two',
          },
        },
      },
      {
        role: 'attribution_visits',
        payload: { kind: 'traffic-observer-fact', observer_id: 'visitor:one', signals: { utm_content: 'intent:one' } },
      },
    ]);

    expect(results).toEqual([]);
  });

  it('can use a unique provider post ID when the evidence feed omits record addresses', () => {
    const results = readPostPerformanceAttributionRows([
      {
        role: 'accepted_publish_statuses',
        payload: {
          kind: 'generic.action-state-event',
          state: 'published',
          intent_id: 'intent:one',
          external_result: {
            service_connection_ref: 'connection:instagram',
            remote_content_id: 'remote:one',
          },
        },
      },
      {
        role: 'observations',
        payload: {
          kind: 'content-analytics.observation',
          observation_id: 'observation:one',
          metrics: { views: 712 },
          evidence: {
            service_connection_ref: 'connection:instagram',
            remote_content_id: 'remote:one',
          },
          observed_at: '2026-09-22T12:00:00Z',
        },
      },
    ]);

    expect(results[0]?.payload).toMatchObject({ remote_content_id: 'remote:one', metrics: { views: 712 } });
  });
});
