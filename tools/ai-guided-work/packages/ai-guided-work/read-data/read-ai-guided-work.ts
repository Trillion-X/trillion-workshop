import {
  decodeOperationClaims,
  decodeOperationRecords,
  isCurrentOperationClaim,
  record,
  type OperationClaim,
  type OperationRecord,
} from '@/packages/operation-records/read-data/operation-records';

export interface AIGuidedWorkSession {
  createdAt: string;
  createdBy: string;
  id: string;
  kind: string;
  learningSessionRef: string;
  repeatInstruction: string;
  state: string;
  subject: string;
}

export interface AIGuidedWorkItem {
  claim: OperationClaim | null;
  operation: OperationRecord;
  session: AIGuidedWorkSession | null;
}

export interface AIGuidedWorkSurface {
  claimCount: number;
  focus: AIGuidedWorkItem | null;
  items: AIGuidedWorkItem[];
  sessionCount: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function decodeSession(raw: unknown): AIGuidedWorkSession | null {
  const row = record(raw);
  const id = text(row.id);
  if (!id) return null;
  return {
    createdAt: text(row.createdAt ?? row.created_at),
    createdBy: text(row.createdBy ?? row.created_by),
    id,
    kind: text(row.kind) || 'ai-guided-work-session',
    learningSessionRef: text(row.learningSessionRef ?? row.learning_session_ref),
    repeatInstruction: text(row.repeatInstruction ?? row.repeat_instruction),
    state: text(row.state) || 'started',
    subject: text(row.subject),
  };
}

function currentClaimForOperation(
  operation: OperationRecord,
  claims: readonly OperationClaim[],
  nowIso?: string,
): OperationClaim | null {
  return claims.find((claim) => isCurrentOperationClaim(claim, operation.id, nowIso)) ?? null;
}

export function decodeAIGuidedWorkSurface(raw: unknown, nowIso?: string): AIGuidedWorkSurface {
  const source = record(raw);
  const operations = decodeOperationRecords(source.operations);
  const claims = decodeOperationClaims(source.claims);
  const sessions = (Array.isArray(source.guidedSessions) ? source.guidedSessions : source.guided_sessions)
    ?? [];
  const decodedSessions = Array.isArray(sessions)
    ? sessions.map(decodeSession).filter((entry): entry is AIGuidedWorkSession => entry !== null)
    : [];
  const sessionsById = new Map(decodedSessions.map((session) => [session.id, session]));
  const items = operations.map((operation): AIGuidedWorkItem => ({
    claim: currentClaimForOperation(operation, claims, nowIso),
    operation,
    session: sessionsById.get(operation.source.id) ?? null,
  }));

  return {
    claimCount: claims.length,
    focus: items[0] ?? null,
    items,
    sessionCount: decodedSessions.length,
  };
}
