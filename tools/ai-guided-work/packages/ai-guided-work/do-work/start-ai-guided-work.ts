import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import aiGuidedWorkContract from '@/packages/ai-guided-work/things-to-store-and-run.json';

export const START_AI_GUIDED_WORK_ACTION = 'action:ai-guided-work:start-session';
const AI_GUIDED_WORK_PACKAGE = 'ai-guided-work';
const DEFAULT_CREATED_BY = 'ai-guided-work';
const GUIDE_ACTOR_REF = 'actor:ai-guided-work.guide';

export interface StartAIGuidedWorkInput {
  createdBy?: string;
  guideSessionId?: string;
  learningSessionId?: string;
  now?: Date;
  repeatInstruction: string;
  subject: string;
}

export interface AIGuidedWorkReceipt {
  envelopeTarget: 'slot::workflow';
  executorActorRef: string;
  executorClaimRef: string;
  guideSessionRef: string;
  learningSessionRef: string;
  learningWorkflowActionId: string;
  operationRef: string;
  repeatInstruction: string;
  repeatRequestRef: string;
  sourcePackage: typeof AI_GUIDED_WORK_PACKAGE;
  startedAt: string;
  subject: string;
  workflowActionId: typeof START_AI_GUIDED_WORK_ACTION;
}

interface GuidedWorkRoute {
  agentProfileRefs: string[];
  claimActorRef: string;
  id: string;
  instructionBlockRefs: string[];
  learningSessionActionId: string;
  memoryContextRefs: string[];
  recommendationActionId?: string;
  waitingPackages: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function uniqueText(values: readonly (string | undefined)[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}

function readRoute(): GuidedWorkRoute {
  const things = Array.isArray(aiGuidedWorkContract.things) ? aiGuidedWorkContract.things : [];
  const payload = things
    .map((thing) => (isRecord(thing) ? thing.payload : null))
    .find((candidate): candidate is Record<string, unknown> => (
      isRecord(candidate) && candidate.kind === 'ai-guided-work-owner-route'
    ));

  return {
    agentProfileRefs: textList(payload?.agent_profile_refs).length ? textList(payload?.agent_profile_refs) : ['package:ai-agent-profile'],
    claimActorRef: text(payload?.claim_actor_ref) || GUIDE_ACTOR_REF,
    id: text(payload?.id) || 'route:ai-guided-work:learning-mastery',
    instructionBlockRefs: textList(payload?.instruction_block_refs).length ? textList(payload?.instruction_block_refs) : ['package:ai-instruction-blocks'],
    learningSessionActionId: text(payload?.learning_session_action_id) || 'action:create-learning-session',
    memoryContextRefs: textList(payload?.memory_context_refs).length ? textList(payload?.memory_context_refs) : ['package:ai-memory'],
    recommendationActionId: text(payload?.recommendation_action_id) || 'action:recommend-next-learning-step',
    waitingPackages: textList(payload?.waiting_packages).length
      ? textList(payload?.waiting_packages)
      : [
          'operation-records',
          'workflow',
          'trigger-engine',
          'learning-mastery-protocol',
          'ai-agent-profile',
          'ai-instruction-blocks',
          'ai-memory',
          'ai-tool-catalog',
          'ai-action-guard',
          'ai-execution-history',
          'journal',
          'process-session',
        ],
  };
}

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function refSuffix(ref: string): string {
  const last = ref.split(':').filter(Boolean).pop() ?? crypto.randomUUID();
  return last.replace(/[^A-Za-z0-9._-]/g, '-') || crypto.randomUUID();
}

function titleFromSubject(subject: string): string {
  return subject.trim().split('\n')[0]?.slice(0, 100) || 'AI guided work';
}

function localDate(now: Date): string {
  return now.toISOString().split('T')[0] ?? now.toISOString();
}

function buildLearningSessionRecord(input: {
  createdAt: string;
  createdBy: string;
  learningSessionId: string;
  subject: string;
}) {
  return {
    aiGenerated: true,
    breakDurationSeconds: 15,
    breakFrequencyMinutes: 15,
    comprehensionChecks: true,
    content: input.subject,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    durationMinutes: 90,
    endedAt: null,
    name: titleFromSubject(input.subject),
    protocolType: 'MLP',
    recommended: true,
    sessionId: input.learningSessionId,
    sessionType: 'learning',
    skillType: 'non-motor',
    startTime: null,
    startedAt: null,
    status: 'pending',
    studyDots: [],
    studyTags: ['ai-guided-work'],
    successTrackingFrequencyMinutes: 15,
    visibility: 'private',
  };
}

export function buildStartAIGuidedWorkInput(input: StartAIGuidedWorkInput): Record<string, unknown> {
  const now = input.now ?? new Date();
  const startedAt = now.toISOString();
  const subject = input.subject.trim();
  const repeatInstruction = input.repeatInstruction.trim();
  const createdBy = input.createdBy ?? DEFAULT_CREATED_BY;
  const route = readRoute();
  const guideSessionId = input.guideSessionId ?? generatedId('ai-guided-work-session');
  const learningSessionId = input.learningSessionId ?? generatedId('learning-session');
  const operationId = `operation:${guideSessionId}`;
  const claimId = `operation-claim:${refSuffix(guideSessionId)}`;
  const claimToken = `operation-claim-token:${refSuffix(guideSessionId)}`;
  const repeatRequestId = `ai-guided-work-repeat:${refSuffix(guideSessionId)}`;
  const waitingPackages = uniqueText(route.waitingPackages);
  const agentProfileRefs = uniqueText(route.agentProfileRefs);
  const instructionBlockRefs = uniqueText(route.instructionBlockRefs);
  const memoryContextRefs = uniqueText(route.memoryContextRefs);
  const guideAddress = `package::ai-guided-work::session::${guideSessionId}`;
  const repeatRequestAddress = `package::ai-guided-work::repeat-request::${repeatRequestId}`;
  const learningSessionAddress = `learning-mastery-session|${learningSessionId}`;
  const repeatRequestRecord = {
    id: repeatRequestId,
    kind: 'ai-guided-work-repeat-request',
    guideSessionRef: guideSessionId,
    subject,
    repeatInstruction,
    state: 'saved',
    targetActionId: START_AI_GUIDED_WORK_ACTION,
    workflowRef: 'slot::workflow',
    triggerRef: 'package:trigger-engine',
    createdAt: startedAt,
  };
  const guidedSessionRecord = {
    id: guideSessionId,
    kind: 'ai-guided-work-session',
    subject,
    repeatInstruction,
    repeatRequestRef: repeatRequestId,
    createdAt: startedAt,
    createdBy,
    state: 'started',
    linkedOwnerActions: [
      {
        ownerPackage: 'learning-mastery-protocol',
        actionDefinitionId: route.learningSessionActionId,
        recordRef: learningSessionId,
      },
      ...(route.recommendationActionId ? [{
        ownerPackage: 'learning-mastery-protocol',
        actionDefinitionId: route.recommendationActionId,
      }] : []),
    ],
    ownerContextRefs: {
      actionGuardCheckRefs: ['package:ai-action-guard'],
      agentProfileRefs,
      executionHistoryRefs: ['package:ai-execution-history'],
      instructionBlockRefs,
      journalRefs: ['package:journal'],
      memoryContextRefs,
      processSessionRefs: ['package:process-session'],
      toolDescriptorRefs: ['package:ai-tool-catalog'],
    },
    learningSessionRef: learningSessionId,
  };
  const operationRecord = {
    id: operationId,
    ownerPackage: AI_GUIDED_WORK_PACKAGE,
    source: {
      package: AI_GUIDED_WORK_PACKAGE,
      type: 'ai-guided-work-session',
      id: guideSessionId,
    },
    kindDescriptor: 'operation.kind.ai-guided-work-session',
    stateDescriptor: 'operation.state.ai-guided-work-started',
    priority: 'normal',
    priorityDescriptor: 'operation.priority.normal',
    timeWindow: {
      localDate: localDate(now),
    },
    linkRefs: uniqueText([
      guideSessionId,
      learningSessionId,
      repeatRequestId,
      guideAddress,
      learningSessionAddress,
      repeatRequestAddress,
      route.id,
      'slot::workflow',
      'package:ai-guided-work',
      'package:learning-mastery-protocol',
      route.learningSessionActionId,
      route.recommendationActionId,
    ]),
    dependencyRefs: waitingPackages,
    evidenceRefs: [guideAddress, learningSessionAddress, repeatRequestAddress],
    candidateFactRefs: [guideAddress, learningSessionAddress, repeatRequestAddress],
    operationClaimRefs: [claimId],
    agentProfileRefs,
    instructionBlockRefs,
    memoryContextRefs,
    toolDescriptorRefs: ['package:ai-tool-catalog'],
    actionGuardCheckRefs: ['package:ai-action-guard'],
    budgetReservationRefs: ['package:agent-wallet'],
    executionHistoryRefs: ['package:ai-execution-history'],
    relationshipEdgeRefs: [],
    trainingBatchRefs: ['package:ai-training-batch'],
    credentialHandleRefs: [],
    providerHandleRefs: [],
    serviceConnectionHandleRefs: [],
    transitions: [],
    display: {
      title: titleFromSubject(subject),
      status: 'Guide started. A learning session is ready.',
      reason: 'The return rule is saved with this guide.',
      detail: [
        subject,
        `Comes back: ${repeatInstruction}`,
        `Learning session: ${learningSessionId}`,
      ],
    },
    privacyClass: 'private',
    modeHints: ['ai', 'guided-work', 'learning'],
    sortKey: startedAt,
    updatedAt: startedAt,
  };
  const claimRecord = {
    id: claimId,
    operationRef: operationId,
    actorRef: route.claimActorRef,
    claimToken,
    claimedAt: startedAt,
    status: 'active',
  };
  const surfaceState = {
    claims: [claimRecord],
    guidedSessions: [guidedSessionRecord],
    operations: [operationRecord],
    repeatRequests: [repeatRequestRecord],
  };

  return {
    claim_id: claimId,
    claim_record: claimRecord,
    guide_session_id: guideSessionId,
    guided_session_record: guidedSessionRecord,
    learning_session_action_id: route.learningSessionActionId,
    learning_session_id: learningSessionId,
    learning_session_input: {
      session_id: learningSessionId,
      session_record: buildLearningSessionRecord({
        createdAt: startedAt,
        createdBy,
        learningSessionId,
        subject,
      }),
    },
    operation_id: operationId,
    operation_record: operationRecord,
    repeat_request_id: repeatRequestId,
    repeat_request_record: repeatRequestRecord,
    surface_state: surfaceState,
  };
}

export function buildStartAIGuidedWorkRequest(input: StartAIGuidedWorkInput) {
  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: START_AI_GUIDED_WORK_ACTION,
      include_steps: false,
      include_output: false,
      input: buildStartAIGuidedWorkInput(input),
    },
  };
}

export function buildCreateLearningSessionRequest(guidedWorkInput: Record<string, unknown>) {
  const actionId = text(guidedWorkInput.learning_session_action_id);
  if (!actionId) throw new Error('learning session action id is required');
  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: actionId,
      include_steps: false,
      include_output: false,
      input: guidedWorkInput.learning_session_input,
    },
  };
}

export function buildAIGuidedWorkSubmission(input: StartAIGuidedWorkInput) {
  const startRequest = buildStartAIGuidedWorkRequest(input);
  const requestInput = startRequest.payload.input as Record<string, unknown>;
  const learningRequest = buildCreateLearningSessionRequest(requestInput);
  const claimRecord = requestInput.claim_record as { actorRef: string };

  return {
    learningRequest,
    receipt: {
      envelopeTarget: 'slot::workflow',
      executorActorRef: claimRecord.actorRef,
      executorClaimRef: text(requestInput.claim_id),
      guideSessionRef: text(requestInput.guide_session_id),
      learningSessionRef: text(requestInput.learning_session_id),
      learningWorkflowActionId: text(requestInput.learning_session_action_id),
      operationRef: text(requestInput.operation_id),
      repeatInstruction: input.repeatInstruction.trim(),
      repeatRequestRef: text(requestInput.repeat_request_id),
      sourcePackage: AI_GUIDED_WORK_PACKAGE,
      startedAt: (input.now ?? new Date()).toISOString(),
      subject: input.subject.trim(),
      workflowActionId: START_AI_GUIDED_WORK_ACTION,
    } satisfies AIGuidedWorkReceipt,
    startRequest,
  };
}

export async function startAIGuidedWork(input: StartAIGuidedWorkInput): Promise<AIGuidedWorkReceipt> {
  const submission = buildAIGuidedWorkSubmission(input);
  await sendRequestToBitfieldTarget(submission.startRequest);
  await sendRequestToBitfieldTarget(submission.learningRequest);
  return submission.receipt;
}
