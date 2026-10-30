// tools/social-posts/read-data/post-results.mjs
//
// tool:see-how-each-post-did: how each place a post went to did, from the person's own `post` records through the
// run's records door (tools/records-door) and the numbers the caller hands in: each place's own counts for a post
// (observations, read from that place's tools), and visits and conversions in the shape tool:break-down-visits-and-sales
// takes. The join is read-data/post-performance-attribution.ts (ported from bitfield-packages
// packages/content-analytics): every number is copied or counted from a row handed in, a missing one stays missing,
// and a link token that could name more than one place counts for none.
//
// One place a post went to is one published row: its identity is the post (post_id, the token a post's link carries),
// the place's account (account_id) and the place's own id for it (platform_post_id).
import { readPostPerformanceAttributionRows } from './post-performance-attribution.ts';
import { KIND } from './post-shape.mjs';

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const placeAddress = (postId, accountId) => `post:${postId}:${accountId}`;
const firstLine = text => (typeof text === 'string' ? text.trim().split('\n')[0].slice(0, 120) : '');

// Each place a post was published to, as the published row the join reads.
function publishedRows(post) {
  return Object.entries(post.deliveries ?? {}).filter(([, delivery]) => delivery?.status === 'posted' && delivery.platform_post_id)
    .map(([accountId, delivery]) => ({
      address: placeAddress(post.post_id, accountId),
      role: 'accepted_publish_statuses',
      payload: {
        kind: 'generic.action-state-event', state: 'published', intent_id: post.post_id, destination_id: accountId,
        title: firstLine(post.caption) || null, observed_at: post.sent_at ?? post.updated_at ?? null,
        ...(post.project_id ? { project_id: post.project_id } : {}),
        external_result: { remote_content_id: delivery.platform_post_id, ...(delivery.url ? { remote_url: delivery.url } : {}), service_connection_ref: accountId },
      },
    }));
}

// A place's own counts for one post: by post_id and account_id, or by the place's id for it.
function observationRow(observation, index) {
  if (!plainObject(observation) || !plainObject(observation.metrics)) throw new Error(`observations[${index}] needs metrics ({ name: number }) and post_id with account_id, or platform_post_id.`);
  const byPost = typeof observation.post_id === 'string' && typeof observation.account_id === 'string';
  if (!byPost && typeof observation.platform_post_id !== 'string') throw new Error(`observations[${index}] needs post_id with account_id, or platform_post_id.`);
  return {
    role: 'observations',
    payload: {
      kind: 'content-analytics.observation', observation_id: observation.observation_id ?? `observation:${index}`,
      metrics: observation.metrics, observed_at: observation.observed_at ?? null,
      evidence: byPost ? { publish_status_ref: placeAddress(observation.post_id, observation.account_id) }
        : { remote_content_id: observation.platform_post_id, ...(typeof observation.account_id === 'string' ? { service_connection_ref: observation.account_id } : {}) },
    },
  };
}

const visitRow = visit => ({ role: 'attribution_visits', payload: { kind: 'traffic-observer-fact', observer_id: String(visit?.visitor ?? ''), ...(visit?.project ? { projectId: visit.project } : {}), signals: plainObject(visit?.signals) ? visit.signals : {} } });
const conversionRow = conversion => ({ role: 'attribution_conversions', payload: { kind: 'traffic-conversion', observer_id: String(conversion?.visitor ?? ''), ...(conversion?.project ? { projectId: conversion.project } : {}), ...(typeof conversion?.value === 'number' ? { value: conversion.value } : {}) } });

/** tool:see-how-each-post-did: one row per place a post was published to that has a count, a visit or a conversion. */
export async function seeHowEachPostDid({ post_ids, observations = [], visits = [], conversions = [] } = {}, { door }) {
  for (const [name, list] of [['observations', observations], ['visits', visits], ['conversions', conversions]]) {
    if (!Array.isArray(list)) throw new Error(`${name} must be a list.`);
  }
  if (post_ids !== undefined && (!Array.isArray(post_ids) || post_ids.some(id => typeof id !== 'string'))) throw new Error('post_ids must be a list of post_id values from tool:read-post-calendar.');
  const wanted = post_ids ? new Set(post_ids) : null;
  const published = [];
  for await (const record of door.list({ type: KIND })) {
    if (record.value && (!wanted || wanted.has(record.value.post_id))) published.push(...publishedRows(record.value));
  }
  const rows = readPostPerformanceAttributionRows([...published, ...observations.map(observationRow), ...visits.map(visitRow), ...conversions.map(conversionRow)]);
  const posts = rows.map(({ payload }) => {
    const place = published.find(row => row.address === payload.evidence.publish_status_ref || row.payload.external_result.remote_content_id === payload.remote_content_id);
    return {
      post_id: payload.intent_id, account_id: place?.payload.destination_id ?? null, title: payload.title,
      platform_post_id: payload.remote_content_id, url: payload.remote_url ?? null, metrics: payload.metrics,
      observed_at: payload.observed_at ?? null, ...(payload.attribution ? { brought: payload.attribution } : {}), evidence: payload.evidence,
    };
  });
  return { posts, places_published: published.length };
}
