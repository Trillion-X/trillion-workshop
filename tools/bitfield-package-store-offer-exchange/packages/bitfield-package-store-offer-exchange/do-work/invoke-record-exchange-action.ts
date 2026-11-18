import type { ExchangeAction, ExchangeRelationship, RuleResult } from '../../../../browse-and-publish-what-my-ai-can-use/packages/bitfield-package-store-offer-exchange/read-data/read-record-exchange-projection';
import { isRecordMap } from '../../../../browse-and-publish-what-my-ai-can-use/packages/bitfield-package-store-offer-exchange/read-data/read-record-exchange-projection';
import { buildOwnerActionIntent, type OwnerActionIntent } from './build-owner-action-intent';

export interface InvokeRecordExchangeActionInput {
  action: ExchangeAction;
  recordRef: string;
  relationships?: ExchangeRelationship[];
  ruleResults?: RuleResult[];
  actorRef?: string;
  correlationRef?: string;
}

export interface InvokeRecordExchangeActionResult {
  invoked: boolean;
  reasonRefs: string[];
  intent?: OwnerActionIntent;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function invokeRecordExchangeAction(input: InvokeRecordExchangeActionInput): InvokeRecordExchangeActionResult {
  const relevantRules = input.action.ruleRefs.length > 0
    ? (input.ruleResults ?? []).filter((result) => input.action.ruleRefs.includes(result.ruleRef))
    : (input.ruleResults ?? []);
  const reasonRefs = relevantRules.filter((result) => !result.pass).map((result) => result.resultRef ?? result.ruleRef);
  if (reasonRefs.length > 0) return { invoked: false, reasonRefs };
  return {
    invoked: true,
    reasonRefs: [],
    intent: buildOwnerActionIntent({
      action: input.action,
      recordRef: input.recordRef,
      relationships: input.relationships,
      actorRef: input.actorRef,
      correlationRef: input.correlationRef,
    }),
  };
}

export function invokeRecordExchangeActionTarget(request: unknown): InvokeRecordExchangeActionResult {
  if (!isRecordMap(request) || !isRecordMap(request.action)) {
    throw new Error('record-exchange-invoke-request-invalid');
  }
  const action = request.action as unknown as ExchangeAction;
  const relationships = Array.isArray(request.relationships)
    ? request.relationships.filter(isRecordMap).map((entry) => ({
        id: text(entry.id),
        sourceRef: text(entry.sourceRef ?? entry.source_ref),
        relationshipRef: text(entry.relationshipRef ?? entry.relationship_ref),
        targetRef: text(entry.targetRef ?? entry.target_ref),
        label: text(entry.label),
      }))
    : [];
  const ruleResults = Array.isArray(request.ruleResults ?? request.rule_results)
    ? (request.ruleResults ?? request.rule_results).filter(isRecordMap).map((entry) => ({
        ruleRef: text(entry.ruleRef ?? entry.rule_ref),
        label: text(entry.label),
        pass: entry.pass === true,
        resultRef: text(entry.resultRef ?? entry.result_ref) || undefined,
        detail: text(entry.detail) || undefined,
      }))
    : [];
  return invokeRecordExchangeAction({
    action,
    recordRef: text(request.recordRef ?? request.record_ref),
    relationships,
    ruleResults,
    actorRef: text(request.actorRef ?? request.actor_ref) || undefined,
    correlationRef: text(request.correlationRef ?? request.correlation_ref) || undefined,
  });
}

