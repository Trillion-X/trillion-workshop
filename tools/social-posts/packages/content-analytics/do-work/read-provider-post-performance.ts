import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export type PublishedPostReadIdentity = {
  publishStatusRef: string;
  sourceId: string;
  observationId: string;
  observedAt: string;
};

export type ProviderPostReadRequest = {
  target: 'slot::workflow';
  payload: {
    operation: 'execute_definition';
    definition_id: 'action:read-provider-post-performance';
    input: {
      publish_status_ref: string;
      source_id: string;
      observation_id: string;
      observed_at: string;
    };
  };
};

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

/**
 * Build the declared workflow request for one published post and one analytics
 * source. The workflow re-reads the current status and source, applies the
 * source's data-driven read profile, invokes the GET/HEAD-only service owner,
 * then normalizes and records real provider fields.
 */
export function buildProviderPostPerformanceReadRequest(
  identity: PublishedPostReadIdentity,
): ProviderPostReadRequest {
  const publishStatusRef = nonEmptyText(identity.publishStatusRef, 'Publish status reference');
  const sourceId = nonEmptyText(identity.sourceId, 'Analytics source ID');
  const observationId = nonEmptyText(identity.observationId, 'Observation ID');
  const observedAt = nonEmptyText(identity.observedAt, 'Observation time');

  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: 'action:read-provider-post-performance',
      input: {
        publish_status_ref: publishStatusRef,
        source_id: sourceId,
        observation_id: observationId,
        observed_at: observedAt,
      },
    },
  };
}

export async function readProviderPostPerformance(
  identity: PublishedPostReadIdentity,
): Promise<unknown> {
  return sendRequestToBitfieldTarget(buildProviderPostPerformanceReadRequest(identity));
}
