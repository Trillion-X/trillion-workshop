import type {
  AcceptedProgressionDecisionReceipt,
  LearningMasteryProtocolDescriptor,
  LearningMasteryProtocolState,
  RenderSurfaceDescriptor,
} from './learning-mastery-types';

export function readLearningMasteryProtocolDescriptor(source: unknown): LearningMasteryProtocolDescriptor | null {
  const value = payload(source);
  if (!isRecord(value)
      || value.kind !== 'learning-mastery-protocol-descriptor'
      || value.schema !== 'learning-mastery-protocol-descriptor/v1'
      || !nonEmpty(value.id)
      || !isRecord(value.defaults)
      || !isRecord(value.lifecycle)
      || !nonEmpty(value.lifecycle.initial)
      || !isRecord(value.lifecycle.transitions)
      || !Array.isArray(value.phases)
      || !Array.isArray(value.transitions)
      || !isRecord(value.actions)
      || !isRecord(value.presentation)) return null;

  const phases = value.phases.filter(isPhase);
  const transitions = value.transitions.filter(isTransition);
  if (phases.length !== value.phases.length || transitions.length !== value.transitions.length) return null;
  if (!phases.some((phase) => phase.id === value.lifecycle.initial)) return null;
  if (!Object.values(value.actions).every(isAction)) return null;
  if (!phases.every((phase) => (phase.embeddedSurfaces ?? []).every(isRenderSurface))) return null;
  return { ...value, phases, transitions } as LearningMasteryProtocolDescriptor;
}

export function readLearningMasteryProtocolState(source: unknown): LearningMasteryProtocolState | null {
  const value = payload(source);
  if (!isRecord(value)
      || value.kind !== 'learning-mastery-protocol-state'
      || !nonEmpty(value.protocol_ref)
      || !nonEmpty(value.state_ref)
      || !Number.isSafeInteger(value.revision)
      || value.revision < 0
      || !nonEmpty(value.phase)
      || !isRecord(value.values)) return null;
  return value as LearningMasteryProtocolState;
}

export function readAcceptedProgressionDecision(source: unknown): AcceptedProgressionDecisionReceipt | null {
  const value = payload(source);
  if (!isRecord(value)
      || value.kind !== 'accepted-progression-decision-receipt'
      || !nonEmpty(value.decision_key)
      || !Number.isFinite(value.confidence)
      || value.confidence < 0
      || value.confidence > 1
      || !isRecord(value.provenance)
      || !isRecord(value.adjustments)
      || !nonEmpty(value.accepted_at)) return null;
  return value as AcceptedProgressionDecisionReceipt;
}

export function projectProtocolValues(
  state: LearningMasteryProtocolState | null,
  decision: AcceptedProgressionDecisionReceipt | null,
): Record<string, unknown> {
  return { ...(state?.values ?? {}), ...(decision?.adjustments ?? {}) };
}

export function transitionIsAllowed(
  descriptor: LearningMasteryProtocolDescriptor,
  from: string,
  to: string,
): boolean {
  return Array.isArray(descriptor.lifecycle.transitions[from])
    && descriptor.lifecycle.transitions[from]!.includes(to);
}

function payload(source: unknown): unknown {
  if (source instanceof Uint8Array) {
    try { return payload(JSON.parse(new TextDecoder().decode(source))); } catch { return null; }
  }
  if (Array.isArray(source)) return source.length === 1 ? payload(source[0]) : null;
  if (!isRecord(source)) return source;
  return source.payload ?? source.value ?? source;
}

function isPhase(value: unknown): value is LearningMasteryProtocolDescriptor['phases'][number] {
  return isRecord(value)
    && nonEmpty(value.id)
    && nonEmpty(value.label)
    && Array.isArray(value.fields)
    && value.fields.every((field) => isRecord(field) && nonEmpty(field.key) && nonEmpty(field.label))
    && (value.embeddedSurfaces === undefined || Array.isArray(value.embeddedSurfaces));
}

function isTransition(value: unknown): value is LearningMasteryProtocolDescriptor['transitions'][number] {
  return isRecord(value)
    && nonEmpty(value.id)
    && nonEmpty(value.from)
    && nonEmpty(value.to)
    && nonEmpty(value.actionKey)
    && nonEmpty(value.label);
}

function isAction(value: unknown): boolean {
  return isRecord(value) && nonEmpty(value.target) && isRecord(value.payload);
}

function isRenderSurface(value: unknown): value is RenderSurfaceDescriptor {
  return isRecord(value)
    && value.schema === 'render-surface-descriptor/v1'
    && isRecord(value.package_entry)
    && nonEmpty(value.package_entry.package_name)
    && nonEmpty(value.package_entry.entry_name);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
