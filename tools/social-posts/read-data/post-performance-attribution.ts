// Join published post readback to provider metrics and first-touch traffic.
// Every displayed number is counted or copied from an existing evidence row;
// this module never fills in missing metrics with a guessed zero.

// An evidence row: where it came from (address), what it is to the join (role) and the record itself (payload).
export type JsonRecord = Record<string, unknown>;
export interface ContentAnalyticsEvidenceRow {
  address?: string;
  role?: string;
  payload?: unknown;
}

const PUBLISHED_STATUS = 'content-distribution.publish-status';
const GENERIC_STATUS = 'generic.action-state-event';
const ANALYTICS_OBSERVATION = 'content-analytics.observation';
const TRAFFIC_VISIT = 'traffic-observer-fact';
const TRAFFIC_CONVERSION = 'traffic-conversion';

type PostIdentity = {
  status: JsonRecord;
  statusRef?: string;
  address: string;
  intentId?: string;
  destinationId?: string;
  remoteId: string;
  remoteUrl?: string;
  connectionRef?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function at(record: unknown, ...path: string[]): unknown {
  let value: unknown = record;
  for (const part of path) {
    if (!isRecord(value)) return undefined;
    value = value[part];
  }
  return value;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return undefined;
}

function refAddress(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value);
  return firstText(at(value, 'address'), at(value, 'record_id'), at(value, 'ref'));
}

function statusIdentity(row: ContentAnalyticsEvidenceRow): PostIdentity | undefined {
  if (!isRecord(row.payload)) return undefined;
  const status = row.payload;
  const kind = text(status.kind);
  if (row.role !== 'accepted_publish_statuses' && kind !== PUBLISHED_STATUS) return undefined;
  if (kind !== PUBLISHED_STATUS && kind !== GENERIC_STATUS) return undefined;
  if (status.state !== 'published') return undefined;

  const remoteId = firstText(
    at(status, 'remote', 'remote_content_id'),
    at(status, 'remote', 'remote_object_id'),
    at(status, 'external_result', 'remote_content_id'),
    at(status, 'external_result', 'remote_object_id'),
    at(status, 'remote_content_id'),
  );
  if (!remoteId) return undefined;
  const connectionRef = firstText(
    at(status, 'remote', 'service_connection_ref'),
    at(status, 'external_result', 'service_connection_ref'),
  );
  const statusRef = refAddress(row.address) ?? refAddress(status.address);
  const address = statusRef ?? `published-post:${connectionRef ?? 'connection-unknown'}:${remoteId}`;

  return {
    status,
    statusRef,
    address,
    intentId: text(status.intent_id),
    destinationId: firstText(status.target_id, status.destination_id, status.destination_ref),
    remoteId,
    remoteUrl: firstText(
      at(status, 'remote', 'remote_url'),
      at(status, 'external_result', 'remote_url'),
      status.remote_url,
    ),
    connectionRef,
  };
}

function observationMatches(observation: JsonRecord, post: PostIdentity): boolean {
  const evidence = isRecord(observation.evidence) ? observation.evidence : {};
  const observedStatusRef = refAddress(evidence.publish_status_ref);
  if (observedStatusRef && post.statusRef) return observedStatusRef === post.statusRef;

  const observedRemoteId = firstText(evidence.remote_content_id, evidence.remote_object_id);
  const observedConnection = text(evidence.service_connection_ref);
  return observedRemoteId === post.remoteId
    && (!observedConnection || !post.connectionRef || observedConnection === post.connectionRef);
}

function trafficIdentity(row: ContentAnalyticsEvidenceRow): JsonRecord | undefined {
  return isRecord(row.payload) ? row.payload : undefined;
}

function utmContent(payload: JsonRecord): string | undefined {
  return firstText(at(payload, 'signals', 'utm_content'), at(payload, 'utm_content'));
}

function matchesUtmPost(payload: JsonRecord, post: PostIdentity, posts: readonly PostIdentity[]): boolean {
  const content = utmContent(payload);
  if (!content) return false;
  const intentDestinationToken = post.intentId && post.destinationId
    ? `${post.intentId}::${post.destinationId}`
    : undefined;
  const postIdentityMatches = content === post.intentId || content === post.remoteId || content === intentDestinationToken;
  if (!postIdentityMatches) return false;
  const candidates = posts.filter((candidate) => content === candidate.intentId
    || content === candidate.remoteId
    || (candidate.intentId && candidate.destinationId && content === `${candidate.intentId}::${candidate.destinationId}`));
  return candidates.length === 1 && candidates[0]?.address === post.address;
}

function projectCompatible(event: JsonRecord, status: JsonRecord): boolean {
  const eventProject = firstText(event.projectId, event.project_id);
  const postProject = firstText(status.projectId, status.project_id);
  return !eventProject || !postProject || eventProject === postProject;
}

function uniqueLatestObservation(
  observations: readonly JsonRecord[],
  post: PostIdentity,
  posts: readonly PostIdentity[],
): JsonRecord | undefined {
  return observations
    .filter((observation) => {
      const evidence = isRecord(observation.evidence) ? observation.evidence : {};
      const referencedStatus = refAddress(evidence.publish_status_ref);
      if (referencedStatus && post.statusRef) return referencedStatus === post.statusRef;

      if (!observationMatches(observation, post)) return false;
      const observedRemoteId = firstText(evidence.remote_content_id, evidence.remote_object_id);
      const observedConnection = text(evidence.service_connection_ref);
      const candidates = posts.filter((candidate) => candidate.remoteId === observedRemoteId
        && (!observedConnection || !candidate.connectionRef || candidate.connectionRef === observedConnection));
      return candidates.length === 1 && candidates[0]?.address === post.address;
    })
    .sort((left, right) => {
      const leftTime = Date.parse(firstText(left.observed_at, left.updated_at) ?? '');
      const rightTime = Date.parse(firstText(right.observed_at, right.updated_at) ?? '');
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    })[0];
}

/**
 * Return one result row per published post that has at least one linked real
 * metric observation or UTM-attributed visit/conversion. UTM attribution uses
 * only an exact `utm_content` match to the stable publish intent or remote ID;
 * campaign/source similarity is deliberately not treated as post identity.
 */
export function readPostPerformanceAttributionRows(
  rows: readonly ContentAnalyticsEvidenceRow[],
): ContentAnalyticsEvidenceRow[] {
  const posts = rows.map(statusIdentity).filter((post): post is PostIdentity => !!post);
  const observations = rows
    .filter((row) => row.role === 'observations')
    .map((row) => row.payload)
    .filter((payload): payload is JsonRecord => isRecord(payload) && payload.kind === ANALYTICS_OBSERVATION);
  const visits = rows
    .filter((row) => row.role === 'attribution_visits')
    .map(trafficIdentity)
    .filter((payload): payload is JsonRecord => !!payload && payload.kind === TRAFFIC_VISIT);
  const conversions = rows
    .filter((row) => row.role === 'attribution_conversions')
    .map(trafficIdentity)
    .filter((payload): payload is JsonRecord => !!payload && payload.kind === TRAFFIC_CONVERSION);

  return posts.flatMap((post) => {
    const observation = uniqueLatestObservation(observations, post, posts);
    const linkedVisits = visits.filter((visit) => matchesUtmPost(visit, post, posts) && projectCompatible(visit, post.status));
    const projectsByObserver = new Map<string, Set<string>>();
    for (const visit of linkedVisits) {
      const observerId = firstText(visit.observer_id, visit.observerId);
      const projectId = firstText(visit.projectId, visit.project_id);
      if (!observerId || !projectId) continue;
      const projects = projectsByObserver.get(observerId) ?? new Set<string>();
      projects.add(projectId);
      projectsByObserver.set(observerId, projects);
    }
    const linkedConversions = conversions.filter((conversion) => {
      const observerId = firstText(conversion.observer_id, conversion.observerId);
      const projectId = firstText(conversion.projectId, conversion.project_id);
      return !!observerId && !!projectId && projectsByObserver.get(observerId)?.has(projectId) === true
        && projectCompatible(conversion, post.status);
    });

    if (!observation && linkedVisits.length === 0 && linkedConversions.length === 0) return [];

    const metrics = isRecord(observation?.metrics) ? observation.metrics : {};
    const values: { visits?: number; conversions?: number; value?: number } = {};
    if (linkedVisits.length > 0) values.visits = linkedVisits.length;
    if (linkedConversions.length > 0) {
      values.conversions = linkedConversions.length;
      const amounts = linkedConversions.map((event) => event.value).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      if (amounts.length > 0) values.value = amounts.reduce((sum, amount) => sum + amount, 0);
    }

    const payload: JsonRecord = {
      id: `published-post:${post.address}`,
      title: firstText(post.status.title, post.status.label, observation?.title, post.remoteId) ?? 'Published post',
      remote_content_id: post.remoteId,
      remote_url: post.remoteUrl,
      intent_id: post.intentId,
      metrics,
      observed_at: firstText(observation?.observed_at, observation?.updated_at, post.status.observed_at),
      attribution: Object.keys(values).length > 0 ? values : undefined,
      evidence: {
        ...(post.statusRef ? { publish_status_ref: post.statusRef } : {}),
        remote_content_id: post.remoteId,
        ...(post.connectionRef ? { service_connection_ref: post.connectionRef } : {}),
        ...(observation ? { observation_id: observation.observation_id } : {}),
        metric_observation_present: !!observation,
        attributed_visit_records: linkedVisits.length,
        attributed_conversion_records: linkedConversions.length,
      },
    };
    return [{ address: post.address, role: 'post_performance', payload }];
  });
}
