// PORTED FROM: bitfield-packages/packages/chat/show/ChatView.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/ChatView.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Main conversation surface for Trillion. Renders the conversation sidebar
// plus either the hero state (no active conversation) or a single feed-backed
// panel. Live turns route through addressed participant ways-to-reach; current
// process-backed ways launch through the `process-session` package.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Canonical session metadata comes from `chat-sessions`
// 2. Canonical transcript content comes from `session-transcripts`
// 3. Live turns use open participant route descriptors; process-backed descriptors route through `process-session`
// 4. New-session and resume-session process execution both go through `process-session`
// 5. Only ephemeral in-flight UI state remains local to this view
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { ArrowLeft, Check, Copy, ListChecks, Users } from 'lucide-react';
import { useBitfieldData } from '#workspace-records';
import { refreshChatModelInventory } from '../do-work/refresh-chat-model-inventory';
import { canRouteSelectedModel } from '../read-data/current-model-availability';
import { useChatDraftAuthority } from './ChatInput';
import { emitPackageSurfaceEntered } from '../../guided-overlay/show/package-onboarding';
import { PresetPopover } from './PresetPopover';
import { focusConversationKey } from './initial-source-keys';
import { ChatPanel, resetChatPanelScrollState } from './ChatPanel';
import { ConversationNavigation } from './ConversationNavigation';
import { useConversationPages } from './use-conversation-pages';
import { ChatErrorBanner, plainChatError } from './ChatErrorBanner';
import { ScreenState } from '../../ui/show/screen-state';
import { later, lazyPart } from '../../ui/show/load-later/later';
// The plan's steps beside the conversation show only when a reply lifts steps out (plan mode): fetched when first shown.
const PlanSidebar = later(() => import('./PlanSidebar'), module => module.PlanSidebar);
import { UnifiedAgentPicker } from './input/unified-agent-picker';
// The AIs to choose from are fetched the first time the person opens them.
const ParticipantBrowser = lazyPart(() => import('./ParticipantBrowser'), module => module.ParticipantBrowser);
import { DisplayMark } from '../../ui/show/display-mark';
import { participantToMarkSpec } from './participant-mark-spec';
import { ChatHeroState } from './ChatHeroState';
import { ChatConnectAiCallout } from './ChatConnectAiCallout';
import { ChatTeammateBar } from './ChatTeammateBar';
import { type InputMode } from './IdeaModePill';
import { getParticipantSendReadinessError } from './chat-send-readiness';
import { resolveInitialConversationSourceSessionRef } from './resolve-source-session-ref';
import { resolveDecoderSessionId } from '../read-data/resolve-decoder-session-id';
import { detectPlanMode, extractExitPlanPayload, parsePlanSteps } from './plan-parser';
import { collectChatTeammates } from '../read-data/read-chat-launch-options';
import {
  decodeActiveChatMessageWindowPayload,
  transcriptLinesToAgentMessages,
} from '../read-data/read-session-transcripts';
import type { SubmitChatTurnInput, ChatTurnSubmission } from '../do-work/submit-chat-turn-via-producer';
import { setSelectedAgent } from '../../selected-agent/do-work/set-selected-agent';
import { decodeCliRegistryParticipants } from '../read-data/read-cli-registry-participants';
import { mergeAgentSelectionParticipants } from '../read-data/merge-agent-selection-participants';
import {
  chooseAgentPresentationParticipants,
  decodeAgentProfileParticipants,
} from '../read-data/read-agent-profile-participants';
import { participantConfigurationIntent } from '../read-data/participant-configuration-intent';
import {
  readChatProducerStatusFromEntries,
  readChatToolResultRecord,
  type ProducerStatus,
} from '../read-data/read-chat-producer-status';
import {
  executeChatWorkRequests,
  expireRoundAuthorization,
  type RoundCapabilityAuthorization,
} from '../do-work/execute-chat-work-requests';
// The agentic tool ROUND is owned by a chat do-work helper (not inlined in this view — no god
// file) that composes chat transport with the owning packages' decision primitives
// (ai-records-producer for continuation, ai-tool-catalog for bounded tool results).
import type { DiscoveredCapability } from '../do-work/discover-capabilities';
import { advanceCapabilityRound } from '../do-work/advance-capability-round';
import { cancelInFlightCapability } from '../do-work/cancel-in-flight-capability';
import type { InFlightCapabilityDispatch } from '../do-work/execute-chat-work-requests';
import { recordCapabilityObservation } from '../do-work/record-capability-observation';
import { createIdeaFromChat } from '../do-work/create-idea-from-chat';
import { executeMessagePerformControl } from '../do-work/execute-message-perform-control';
import { submitMessageEgressFromChat } from '../do-work/submit-message-egress-from-chat';
import { materializeAddressedExchange } from '../do-work/materialize-addressed-exchange';
import { readChatPromptAssembly } from '../read-data/read-chat-prompt-assembly';
import { readChatResultPolicy } from '../read-data/read-chat-result-policy';
import { readChatTransitionPolicy } from '../read-data/read-chat-transition-policy';
import type { ChatAddressedExchangeTurnDraft } from '../do-work/write-addressed-exchange-through-conversations';
import { createChatAddressedExchangeConversationId, createChatAddressedExchangeTurnId } from '../do-work/addressed-exchange-ids';
// The send road (dispatching a message, writing the exchange, the tool round and its capability discovery, the producer
// turn, a participant's setup form) is fetched when the person first sends or submits, so opening a conversation never
// waits on it (../do-work/chat-send-work).
const loadChatSendWork = () => import('../do-work/chat-send-work');
import { useChatConversationProjections } from '../read-data/use-chat-conversation-projections';
import type { ChatCanonicalAgentMessage } from '../read-data/map-conversation-projections-to-chat';
import { usePrivateConversations } from '../read-data/use-private-conversations';
import { invokePrivateConversation } from '../read-data/read-private-conversations';
import { projectConversationWork, type ConversationCorrectionAction } from '../read-data/project-conversation-work';
import { projectConversationNotifications } from '../read-data/project-conversation-owner-events';
import { invokeOperationTransition } from '../../operation-records/do-work/invoke-operation-transition';
import {
  readChatTranscriptPage,
  TranscriptPagePublishedError,
  type ChatTranscriptPage,
  type ReadChatTranscriptPageInput,
} from '../do-work/read-chat-transcript-page';
import { refreshChatHistory } from '../do-work/refresh-chat-history';
import {
  decodeActiveChatSessionWindowPayload,
  type ChatConversationRecord,
  type ConversationSendCapability,
} from '../read-data/read-chat-sessions';
import {
  type ChatConversationTranscriptRecord,
} from '../read-data/read-session-transcripts';
import {
  isProcessSessionEventDeltaPayload,
  readProcessSessionEventHead,
  readProcessSessionEventsFeed,
  type ProcessSessionEventsFeedView,
  type ProcessSessionState,
} from '../../process-session/read-data/read-process-session-events';
import {
  decodeChatSelectedTextForNextAgentRequestFeed,
  type ChatSelectedTextForNextAgentRequest,
} from '../read-data/read-selected-text-for-next-agent-request';
import {
  decodeChatCurrentProjectFeed,
  type ChatCurrentProjectFeed,
} from '../read-data/read-chat-projects';
import {
  basename,
  decodeAddressedParticipantsFeed,
  findAddressedParticipantAccount,
  getAddressedParticipantDefaultModelId,
  getAddressedParticipantModels,
  isAiRecordsProducerAddressedWayToReachAdapter,
  isProcessAddressedWayToReachAdapter,
  type AddressedParticipantAccount,
  type AddressedParticipantInfo,
  type AddressedParticipantModelOption,
} from '../read-data/read-addressed-exchange-participants';
import { findChatWorkflowActions } from '../read-data/read-chat-work-actions';
import { readMessageAnnotationPalette } from '../read-data/read-message-annotation-palette';
import {
  decodeAddressedContextGrantsFeed,
  type AddressedContextGrant,
} from '../read-data/read-addressed-exchange';
import { ActionControl, AvatarGroup, Form, Input } from '../../ui';
import { Badge, Card, Icon, Text, Container, Tooltip } from '../../ui';
import { emitPlaceableSurfaceIntent, readPlaceableSurfaces, readPublishedRecords } from '../../ui/show/placeable-surface-intent';
import { AgentStatusStrip } from './AgentStatusStrip';
import { buildAgentStatusSessions, type AgentTurnDescriptor, type AgentSessionStatus } from './build-agent-status-sessions';
import type { AgentMessage, MessageActionDescriptor, MessageIntent, MessagePerformHandler, MessageReaction } from '../read-data/chat-message-types';
import { EMPTY_STREAM_PARSE_SPEC } from '../read-data/stream-parse-spec';
import type { ChatSessionConfig } from '../read-data/read-chat-sessions';
import { decodeChatPresetsFeed, type Preset } from '../read-data/read-chat-presets';
import {
  canChangeChatProviderSelection,
  resolveEditableParticipantRefs,
} from './chat-config-ownership';
import { FloatingPanel } from '../../screen-arrangement/show/FloatingPanel';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
interface PendingConversation {
  recordId: string | null;
  ledgerConversationId: string | null;
  sourceSessionRef: string | null;
  participantRef: string;
  participantRefs: string[];
  accountDir: string | null;
  projectSlug: string | null;
  projectLabel: string | null;
  sourcePath: string | null;
  startedAt: string;
  baselineMessageCount: number;
  messages: AgentMessage[];
  routeResultsByParticipantRef: Record<string, AddressedRouteResult>;
}

interface ProducerTurn {
  requestId: string;
  submission: ChatTurnSubmission;
  userVisibleContent: string;
  selectedSessionId: string | null;
  ledgerConversationId: string | null;
  userTurnId: string | null;
  userParentTurnId: string | null;
  userTurnSequence: number;
  ledgerConversationTitle: string | null;
  ledgerConversationCreatedAt: string | null;
  ledgerParticipantRefs: string[];
  ledgerWayRefs: string[];
  ledgerServiceConnectionRefs: string[];
  ledgerProjectSlug: string | null;
  ledgerProjectLabel: string | null;
  canonicalTurnDrafts: ChatAddressedExchangeTurnDraft[];
  ledgerAccountDir: string | null;
  sourcePath: string | null;
  startedAt: string;
  startedAtMs: number;
  state: 'pending' | 'done' | 'error';
  errorMessage: string | null;
  assistantReplyText: string | null;
  // ReAct tool loop (#53 S2): re-prompt the same agent with tool results until it
  // answers with no more fences (bounded). Set on the initial turn so a continuation
  // turn re-uses the same agent/model and re-anchors on the original user intent.
  userText: string;
  agentRef: string | null;
  modelId: string | null;
  toolRound: number;
  // Visible agentic trail (#53 follow-up): what the agent is doing — the tool calls
  // it ran + their outcomes — so the user SEES the work during the loop instead of
  // staring at a silent spinner. Accumulates across rounds; rendered as status lines.
  toolActivity: Array<{ id: string; content: string }>;
  /** Opaque next-round capability authority, derived from owner discovery only. */
  capabilityAuthorization: RoundCapabilityAuthorization | null;
  discoveredCapabilities: readonly DiscoveredCapability[];
  callerAuthorityRef: string;
}

interface PendingSetupForm {
  participant: AddressedParticipantInfo;
  routeRef: string;
  fieldValues: Record<string, string>;
  submitting: boolean;
}

interface LiveProcessSessionEventSnapshot {
  outputText: string;
  lastEventNumber: number;
  state: ProcessSessionState;
  exitCode: number | null;
  failureReason: string | null;
  matchedEventCount: number;
}

interface SessionMetaBarProps {
  participantRef: string;
  participantInfos: readonly AddressedParticipantInfo[];
  accountLabel: string | null;
  projectLabel: string | null;
  messages: AgentMessage[];
  /** Distinct participant refs that actually spoke in this conversation (#57). */
  conversationSpeakerRefs?: readonly string[];
  /** The ref of the participant who spoke last (#57 — model can change per turn). */
  lastSpeakerRef?: string;
  hasPlan: boolean;
  onOpenPlan: () => void;
  onOpenParticipants?: () => void;
  agentSessions?: readonly AgentSessionStatus[];
}

const LIVE_TURN_DIAGNOSTIC_PREFIX = '[chat/live-turn]';

function monotonicNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function elapsedMsSince(startedAtMs: number): number {
  return Math.round((monotonicNowMs() - startedAtMs) * 100) / 100;
}

function logLiveTurnDiagnostic(event: string, details: Record<string, unknown>): void {
  if (typeof console === 'undefined' || typeof console.info !== 'function') return;
  console.info(LIVE_TURN_DIAGNOSTIC_PREFIX, event, details);
}

const EMPTY_ACCOUNTS: AddressedParticipantAccount[] = [];
const INITIAL_CHAT_CONFIG: ChatSessionConfig = {
  participantRefs: [],
  participantRef: '',
  accountId: '',
  model: null,
};
const LIVE_TURN_OUTPUT_DECODER = new TextDecoder();
const SELECTED_TRANSCRIPT_PAGE_LIMIT = 256;
const SELECTED_TRANSCRIPT_SOURCE_RECONCILE_ATTEMPTS = 40;
const SELECTED_TRANSCRIPT_SOURCE_RECONCILE_DELAY_MS = 500;
const PROCESS_DIAGNOSTIC_MAX_CHARS = 4000;
const CHAT_SESSION_RECORD_PREFIX = 'chat_session:';
const SESSION_TRANSCRIPT_RECORD_PREFIX = 'session_transcript:';

function normalizeChatSessionConfig(input: Omit<ChatSessionConfig, 'participantRef'> & { participantRef?: string }): ChatSessionConfig {
  const participantRefs = input.participantRefs.length > 0
    ? Array.from(new Set(input.participantRefs.filter(Boolean)))
    : input.participantRef
      ? [input.participantRef]
      : [];
  return {
    ...input,
    participantRefs,
    participantRef: participantRefs[0] ?? '',
  };
}

function grantVisibleToTurn(
  grant: AddressedContextGrant,
  exchangeScopeRef: string | null,
  participantRefs: ReadonlySet<string>,
): boolean {
  const exchangeScopeMatches = !exchangeScopeRef
    || grant.exchangeScopeRef === null
    || grant.exchangeScopeRef === exchangeScopeRef;
  const participantMatches = grant.participantRef === null || participantRefs.has(grant.participantRef);
  return exchangeScopeMatches && participantMatches;
}

type TranscriptPageReader = (
  input: ReadChatTranscriptPageInput,
  signal?: AbortSignal,
) => Promise<ChatTranscriptPage>;

function abortError(): Error {
  return new Error('Transcript source reconciliation was aborted');
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isTransientCarrierError(error: unknown): boolean {
  const message = errorWords(error);
  return message.includes('CarrierFrame transport closed')
    || message.includes('CarrierFrame websocket failed to open')
    || message.includes('CarrierFrame websocket closed before');
}

function waitForTranscriptSourceRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (isAbortSignalAborted(signal)) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timeout);
      reject(abortError());
    }, { once: true });
  });
}

export async function readLatestSourceTranscriptPage(
  filePath: string,
  options: {
    sessionId?: string | null;
    signal?: AbortSignal;
    readPage?: TranscriptPageReader;
    maxAttempts?: number;
    retryDelayMs?: number;
  } = {},
): Promise<ChatTranscriptPage> {
  const readPage = options.readPage ?? readChatTranscriptPage;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 0));
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isAbortSignalAborted(options.signal)) throw abortError();
    try {
      return await readPage({
        sessionId: options.sessionId ?? null,
        filePath,
        startIndex: -1,
        limit: SELECTED_TRANSCRIPT_PAGE_LIMIT,
      }, options.signal);
    } catch (error) {
      lastError = error;
      if (!isTransientCarrierError(error) || attempt === maxAttempts) throw error;
      await waitForTranscriptSourceRetry(retryDelayMs, options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function transcriptPageHasAssistantAfterMessage(
  page: ChatTranscriptPage,
  message: AgentMessage,
): boolean {
  const content = message.content.trim();
  if (!content) return false;
  const messages = transcriptLinesToAgentMessages(page.lines);
  const userIndex = messages.findIndex((candidate) => (
    candidate.role === 'human'
    && candidate.content.trim() === content
  ));
  if (userIndex < 0) return false;
  return messages.slice(userIndex + 1).some((candidate) => (
    candidate.role === 'assistant'
    && candidate.content.trim().length > 0
  ));
}

export async function readLatestSourceTranscriptPageUntilResponse(
  filePath: string,
  message: AgentMessage,
  options: {
    sessionId?: string | null;
    signal?: AbortSignal;
    readPage?: TranscriptPageReader;
  } = {},
): Promise<{ matched: boolean; page: ChatTranscriptPage }> {
  let lastPage: ChatTranscriptPage | null = null;
  for (let attempt = 1; attempt <= SELECTED_TRANSCRIPT_SOURCE_RECONCILE_ATTEMPTS; attempt += 1) {
    let page: ChatTranscriptPage;
    try {
      page = await readLatestSourceTranscriptPage(filePath, {
        ...options,
        maxAttempts: 1,
      });
    } catch (error) {
      if (!isTransientCarrierError(error) || attempt === SELECTED_TRANSCRIPT_SOURCE_RECONCILE_ATTEMPTS) {
        throw error;
      }
      await waitForTranscriptSourceRetry(SELECTED_TRANSCRIPT_SOURCE_RECONCILE_DELAY_MS, options.signal);
      continue;
    }
    lastPage = page;
    if (transcriptPageHasAssistantAfterMessage(page, message)) {
      return { matched: true, page };
    }
    if (attempt < SELECTED_TRANSCRIPT_SOURCE_RECONCILE_ATTEMPTS) {
      await waitForTranscriptSourceRetry(SELECTED_TRANSCRIPT_SOURCE_RECONCILE_DELAY_MS, options.signal);
    }
  }
  if (!lastPage) throw new Error('Transcript source reconciliation did not return a page');
  return { matched: false, page: lastPage };
}

function boundedProcessDiagnostic(outputText: string): string | null {
  const trimmed = outputText.trim();
  if (!trimmed) return null;
  if (trimmed.length <= PROCESS_DIAGNOSTIC_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, PROCESS_DIAGNOSTIC_MAX_CHARS)}\n...`;
}

function titleFromPrompt(content: string): string {
  const firstLine = content.trim().split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'New chat';
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`;
}

function comparableMessageKey(message: AgentMessage): string | null {
  if (message.type !== 'text') return null;
  if (message.role !== 'human' && message.role !== 'assistant') return null;
  const content = message.content.trim();
  return content ? `${message.role}\u0000${content}` : null;
}

export function pendingMessagesAbsorbedByCanonical(
  canonicalMessages: AgentMessage[],
  pendingMessages: AgentMessage[],
): boolean {
  const pendingKeys = pendingMessages
    .map(comparableMessageKey)
    .filter((key): key is string => key !== null);
  if (pendingKeys.length === 0) return false;

  const remainingCanonicalKeys = canonicalMessages
    .map(comparableMessageKey)
    .filter((key): key is string => key !== null);

  return pendingKeys.every((pendingKey) => {
    const index = remainingCanonicalKeys.indexOf(pendingKey);
    if (index < 0) return false;
    remainingCanonicalKeys.splice(index, 1);
    return true;
  });
}

function decodeLiveProcessSessionSnapshot(
  feed: ProcessSessionEventsFeedView,
  processSessionId: string,
  fallbackState: ProcessSessionState,
  fallbackExitCode: number | null,
  fallbackFailureReason: string | null,
): LiveProcessSessionEventSnapshot {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let lastEventNumber = 0;
  let state = fallbackState;
  let exitCode = fallbackExitCode;
  let failureReason = fallbackFailureReason;
  let matchedEventCount = 0;

  feed.forEachEvent({
    onOutputBytes(sessionId, eventNumber, _recordedAtMs, _stream, bytes) {
      if (sessionId !== processSessionId) return;
      matchedEventCount += 1;
      chunks.push(bytes);
      totalBytes += bytes.byteLength;
      lastEventNumber = Math.max(lastEventNumber, eventNumber);
    },
    onSessionStateChanged(sessionId, eventNumber, _recordedAtMs, nextState, nextExitCode, nextFailureReason) {
      if (sessionId !== processSessionId) return;
      matchedEventCount += 1;
      state = nextState;
      exitCode = nextExitCode;
      failureReason = nextFailureReason;
      lastEventNumber = Math.max(lastEventNumber, eventNumber);
    },
    onCommandRejected(sessionId, eventNumber, _recordedAtMs, reason) {
      if (sessionId !== processSessionId) return;
      matchedEventCount += 1;
      state = 'failed';
      failureReason = reason;
      lastEventNumber = Math.max(lastEventNumber, eventNumber);
    },
  });

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    outputText: LIVE_TURN_OUTPUT_DECODER.decode(combined),
    lastEventNumber,
    state,
    exitCode,
    failureReason,
    matchedEventCount,
  };
}

function makeSessionParticipantInfo(
  participantRef: string | null | undefined,
  accountDir: string | null | undefined,
  model: string | null | undefined,
): AddressedParticipantInfo | null {
  if (!participantRef) return null;
  const account = accountDir
    ? [{ id: accountDir, label: accountDir, configDir: '' }]
    : [];
  const models = model
    ? [{ id: model, label: model, isDefault: true }]
    : [];
  return {
    participantRef,
    wayToReachRef: null,
    label: participantRef,
    version: '',
    accounts: account,
    models,
    adapter: null,
    badgeColor: null,
    providerRefs: [],
    capabilityRefs: [],
    serviceConnectionRefs: [],
    credentialHandleRefs: [],
    requiresAuth: false,
    routeRefs: [],
    setupRouteRefs: [],
    connectionStateRefs: [],
    ingestionRouteRefs: [],
    resultProjectionRefs: [],
    streamParseSpecRefs: [],
    proofRefs: [],
    blockerRefs: [],
    routeDescriptors: [],
    connectionStates: [],
    permissionRef: null,
    guardRef: null,
    statusRef: null,
    metadata: {},
    displayMark: {
      iconName: null,
      logoUrl: null,
      text: null,
      background: null,
      foreground: null,
      border: null,
    },
  };
}

type ConnectSubmitState =
  | { kind: 'connected' }
  | { kind: 'pending' }
  | { kind: 'blocked'; message: string };

function textFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readConnectReplyMessage(reply: Record<string, unknown>): string {
  return (
    textFromUnknown(reply.error)
    ?? textFromUnknown(reply.message)
    ?? textFromUnknown(reply.reason)
    ?? 'Participant setup did not complete.'
  );
}

function classifyConnectSubmitReply(reply: Record<string, unknown>): ConnectSubmitState {
  const status = textFromUnknown(reply.status)
    ?? textFromUnknown(reply.state)
    ?? textFromUnknown(reply.status_ref)
    ?? textFromUnknown(reply.statusRef);
  const normalizedStatus = status?.toLowerCase() ?? null;
  if (reply.success === false || reply.ok === false || reply.error || reply.blocked) {
    return { kind: 'blocked', message: readConnectReplyMessage(reply) };
  }
  if (normalizedStatus?.includes('blocked') || normalizedStatus?.includes('error') || normalizedStatus?.includes('failed')) {
    return { kind: 'blocked', message: readConnectReplyMessage(reply) };
  }
  if (reply.connected === true || normalizedStatus?.includes('connected') || normalizedStatus === 'success') {
    return { kind: 'connected' };
  }
  if (reply.pending === true || normalizedStatus?.includes('pending') || normalizedStatus?.includes('setting')) {
    return { kind: 'pending' };
  }
  return { kind: 'blocked', message: 'Participant setup returned no connected or pending state.' };
}

function participantHasRouteTarget(participant: AddressedParticipantInfo | undefined): boolean {
  return Boolean(participant?.routeDescriptors.some((route) => route.targetRef));
}

export function getViewMode(
  activeSessionId: string | null,
  hasPendingConversation: boolean,
): 'empty' | 'single' {
  return activeSessionId || hasPendingConversation ? 'single' : 'empty';
}

export function shouldAutoPip(isProcessing: boolean): boolean {
  return isProcessing;
}

// The provider-selection ownership predicate lives in a zero-dependency leaf
// (chat-config-ownership.ts) so it is independently unit-testable and shared by
// its two readers as ONE definition (SSOT): the provider picker UI and the
// default-participant normalizer effect below. Re-exported here to preserve the
// historical export surface.
export { canChangeChatProviderSelection };

export function selectCanonicalChatMessages(input: {
  selectedWindowMessages: AgentMessage[];
  selectedWindowLoading: boolean;
  selectedWindowError?: string | null;
  transcriptMaterializing?: boolean;
  loadingMessageId: string;
  loadingTimestamp: string;
}): AgentMessage[] {
  if (input.selectedWindowMessages.length > 0) return input.selectedWindowMessages;
  if (input.selectedWindowError) {
    return [{
      id: input.loadingMessageId,
      type: 'status',
      content: input.selectedWindowError,
      role: 'assistant',
      timestamp: input.loadingTimestamp,
    }];
  }
  if (input.selectedWindowLoading) {
    return [{
      id: input.loadingMessageId,
      type: 'status',
      content: 'Loading the latest transcript messages...',
      role: 'assistant',
      timestamp: input.loadingTimestamp,
    }];
  }

  if (input.transcriptMaterializing) {
    return [{
      id: input.loadingMessageId,
      type: 'status',
      content: 'Preparing the full transcript for this chat...',
      role: 'assistant',
      timestamp: input.loadingTimestamp,
    }];
  }

  return [];
}

export function deriveSessionTranscriptIdFromChatSessionId(recordId: string): string | null {
  if (!recordId.startsWith(CHAT_SESSION_RECORD_PREFIX)) return null;
  return `${SESSION_TRANSCRIPT_RECORD_PREFIX}${recordId.slice(CHAT_SESSION_RECORD_PREFIX.length)}`;
}

export function mergeChatTranscriptRecords(
  sourceRecords: ChatConversationTranscriptRecord[],
  materializedRecords: ChatConversationTranscriptRecord[],
): ChatConversationTranscriptRecord[] {
  const merged = new Map<string, ChatConversationTranscriptRecord>();
  for (const record of sourceRecords) {
    if (!record.session_id) continue;
    merged.set(record.session_id, record);
  }
  for (const record of materializedRecords) {
    if (!record.session_id) continue;
    const existing = merged.get(record.session_id);
    merged.set(record.session_id, existing ? { ...existing, ...record } : record);
  }
  return Array.from(merged.values());
}

export function buildSelectedTranscriptMaterialization(input: {
  session: ChatConversationRecord | null;
  transcriptRecord: ChatConversationTranscriptRecord | null;
}): {
  recordId: string;
  transcriptId: string;
  filePath: string;
  key: string;
} | null {
  if (!input.session?.filePath) return null;
  const transcriptId = input.transcriptRecord?.transcript_id
    ?? deriveSessionTranscriptIdFromChatSessionId(input.session.recordId);
  if (!transcriptId) return null;
  return {
    recordId: input.session.recordId,
    transcriptId,
    filePath: input.session.filePath,
    key: [
      input.session.recordId,
      transcriptId,
      input.session.filePath,
      input.session.fileModifiedAt ?? '',
      input.session.fileSizeBytes ?? '',
    ].join('\u0000'),
  };
}

export function getSessionIds(sessions: ChatConversationRecord[]): string[] {
  return sessions.map((session) => session.recordId);
}

function formatConversationForCopy(messages: AgentMessage[]): string {
  return messages.flatMap((msg) => {
    if (msg.type === 'thinking' || msg.type === 'tool_use' || msg.type === 'tool_result' || isCompactionSummaryContent(msg.content)) {
      return [];
    }
    const roleLabel = msg.role === 'human' ? 'You' : 'Assistant';
    const timestamp = msg.timestamp ? `[${msg.timestamp}]` : '';
    return [`${timestamp} ${roleLabel}\n${msg.type === 'error' ? plainChatError(msg.content) : msg.content}`];
  }).join('\n\n');
}

function SessionMetaBar({
  participantRef,
  participantInfos,
  accountLabel,
  projectLabel,
  messages,
  conversationSpeakerRefs = [],
  lastSpeakerRef = '',
  hasPlan,
  onOpenPlan,
  onOpenParticipants,
  agentSessions,
}: SessionMetaBarProps) {
  const [copied, setCopied] = useState<'none' | 'conversation'>('none');

  const copyText = useCallback((kind: 'conversation', value: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied('none'), 1400);
    }).catch(() => {
      // Clipboard may be unavailable.
    });
  }, []);


  // Resolve the active participant ref to a HUMAN name (who you're chatting with),
  // never the raw routing ref "cli:codex" (L114). Prefer the participant record's
  // label; fall back to a humanized ref so a not-yet-registered participant still
  // reads cleanly. This is the persistent "last chatted with" indicator — shown
  // whether or not a turn is currently running.
  const resolveParticipant = useCallback((ref: string) => (
    participantInfos.find((p) => p.participantRef === ref)
    ?? { participantRef: ref, label: 'Participant' }
  ), [participantInfos]);

  const activeParticipant = participantInfos.find((p) => p.participantRef === participantRef);
  const participantDisplayName = activeParticipant?.label || 'Participant';

  // #57 — the avatar row reflects the conversation's REAL roster (who actually
  // spoke, from the canonical turns) once anyone has replied; before the first reply
  // it falls back to the selected participants. "last {X}" names who spoke last;
  // when the next-turn selection differs, "· next {Y}" shows where the next
  // message will go (the model can change mid-chat).
  const rosterInfos = conversationSpeakerRefs.length > 0
    ? conversationSpeakerRefs.map(resolveParticipant)
    : participantInfos;
  const lastSpeakerLabel = lastSpeakerRef ? resolveParticipant(lastSpeakerRef).label : '';

  return (
    <Card variant="nested" padding="none" borderless className="px-3 py-1.5">
      <Container layout="vertical" gap="none" padding="none">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" padding="none">
          <Container layout="horizontal" gap="sm" alignItems="center" padding="none" className="min-w-0 flex-1">
            <Text variant="caption" color="muted">Conversation</Text>
          </Container>

          <ActionControl
            variant="ghost"
            size="sm"
            onClick={() => copyText('conversation', formatConversationForCopy(messages))}
            title="Copy full conversation"
          >
            <Icon icon={copied === 'conversation' ? Check : Copy} size="xs" color={copied === 'conversation' ? 'success' : 'ghost'} />
            Copy conversation
          </ActionControl>
          {hasPlan && (
            <ActionControl
              variant="ghost"
              size="sm"
              onClick={onOpenPlan}
              title="Open plan"
            >
              <Icon icon={ListChecks} size="xs" color="ghost" />
              Plan
            </ActionControl>
          )}
        </Container>

        <Container layout="horizontal" gap="sm" alignItems="center" padding="none" wrap>
          {rosterInfos.length > 0 && (
            <AvatarGroup
              size="xs"
              ringToken="glass-subtle"
              ariaLabel="Session participants"
              onClick={onOpenParticipants}
              onOverflowClick={onOpenParticipants}
              items={rosterInfos.map((participant) => ({
                key: participant.participantRef,
                node: <DisplayMark spec={participantToMarkSpec(participant)} size="xs" />,
              }))}
            />
          )}
          {lastSpeakerRef ? (
            <>
              <Text variant="caption" color="ghost">Last reply:</Text>
              <Text variant="caption" color="muted">{lastSpeakerLabel}</Text>
              {participantDisplayName && participantRef !== lastSpeakerRef && (
                <>
                  <Text variant="caption" color="ghost">Next message:</Text>
                  <Text variant="caption" color="muted">{participantDisplayName}</Text>
                </>
              )}
            </>
          ) : participantDisplayName && (
            <>
              <Text variant="caption" color="ghost">Talking with:</Text>
              <Text variant="caption" color="muted">{participantDisplayName}</Text>
            </>
          )}
          {accountLabel && <Text variant="caption" color="faint">{accountLabel}</Text>}
          {projectLabel && <Text variant="caption" color="faint">{projectLabel}</Text>}
        </Container>

        {agentSessions && agentSessions.length > 0 && (
          <AgentStatusStrip sessions={agentSessions} />
        )}

      </Container>
    </Card>
  );
}

export interface EmptyStateProps {
  onStartConversation?: () => void;
}

export function EmptyState({ onStartConversation }: EmptyStateProps) {
  return (
    <div className="flex items-center justify-center w-full h-full p-4">
      <Card variant="surface" padding="lg" className="max-w-sm text-center">
        <Card variant="nested" padding="sm" className="mx-auto w-16 h-16 flex items-center justify-center mb-4">
          <Icon icon={MessageSquare} size="xl" color="ghost" />
        </Card>
        <Text variant="heading-lg" className="mb-2">
          Start a conversation
        </Text>
        <Text variant="body" color="subtle" className="mb-6">
          Open a chat session with an AI agent to begin collaborating. Each
          session runs independently and you can manage multiple conversations
          in parallel.
        </Text>
        <ActionControl
          variant="secondary"
          onClick={onStartConversation}
          disabled={!onStartConversation}
        >
          New Conversation
        </ActionControl>
      </Card>
    </div>
  );
}

export interface ChatViewProps {
  onStartConversation?: () => void;
  // An embedding host passes `surfaceInput` DATA verbatim.
  // `focusConversation` opens an opaque conversation,
  // and `initialAssistantMessage` supplies a visible seed only while canonical
  // history is empty. Generic (L090): ChatView enumerates none of their domains.
  surfaceInput?: Record<string, unknown>;
  // Actions on the record a message is (DATA from the host, e.g. a kind's erase action), offered beside the palette's
  // and answered by the host: they are not annotations and never ride the intent ledger.
  recordActions?: readonly MessageActionDescriptor[];
  onRecordAction?: (intent: MessageIntent) => void;
  // Told on each edit in the composer, so the host can tell the others in the conversation this person is typing.
  onTyping?: () => void;
}

function ChatViewContents({ onStartConversation: _onStartConversation, surfaceInput, recordActions, onRecordAction, onTyping }: ChatViewProps) {
  const navigationInstanceId = React.useId();
  // In a narrow frame the list and the open conversation take turns (screen-look chat.css); which one is shown.
  const [narrowPane, setNarrowPane] = useState<'list' | 'detail'>('detail');
  useEffect(() => {
    emitPackageSurfaceEntered('chat', 'chat');
  }, []);

  // A containing surface may expose one opaque active placement destination.
  // Chat does not decode or name the owner; it only offers the explicit
  // "Open in workspace" action for a trusted receipt-selected surface.
  const surfaceIntentDestinationRef = typeof surfaceInput?.surface_intent_destination_ref === 'string'
    && surfaceInput.surface_intent_destination_ref.trim().length > 0
    ? surfaceInput.surface_intent_destination_ref.trim()
    : null;
  // A mounting surface may seed the composer with a one-time prompt via its own
  // surfaceInput DATA (e.g. an onboarding hand-off). Generic (L090): the text is
  // DATA and ChatView never names who set it. ChatComposer applies prefillValue
  // once (sets the field, focuses, does NOT auto-send) then fires onPrefillConsumed;
  // clearing the local state stops it re-applying on this mount. Absent key = no prefill.
  const [composerPrefill, setComposerPrefill] = useState<string | undefined>(
    () => (typeof surfaceInput?.prefill_text === 'string' && surfaceInput.prefill_text.trim().length > 0
      ? surfaceInput.prefill_text
      : undefined),
  );
  const handleComposerPrefillConsumed = useCallback(() => setComposerPrefill(undefined), []);
  const sessionsEntry = useBitfieldData('chat-session-window');
  const sessionWindow = useMemo(() => decodeActiveChatSessionWindowPayload(sessionsEntry), [sessionsEntry]);
  const conversationPages = useConversationPages(sessionWindow.conversation_page_cursor, sessionWindow.conversation_page_error);
  const canonicalConversations = useChatConversationProjections();
  const presetsEntry = useBitfieldData('presets');
  const currentProjectEntry = useBitfieldData('current-project');
  // L126: the 4 published-record folds below read THREE scoped
  // record_from_matching_records feeds instead of the 34.7MB `published-records`
  // aggregate — chat-owned records (prompt-assembly + annotation-palette),
  // workflow-action definitions, and service-connections provider descriptors.
  // The shared ui `readPublishedRecords` normalizes each feed's
  // {record:{address},payload} rows to the same shape the aggregate projected, so
  // every fold's predicate (shape / recordId / vendor) is unchanged.
  const chatOwnedRecordsEntry = useBitfieldData('chat-owned-records');
  const workflowActionRecordsEntry = useBitfieldData('workflow-action-records');
  const placeableSurfacesEntry = useBitfieldData('placeable-surface-list');
  const contextGrantsEntry = useBitfieldData('addressed-exchange-context-grants');

  const sessions = useMemo(() => {
    const canonicalIds = new Set(canonicalConversations.sessions.map((session) => session.recordId));
    const latestIds = new Set(sessionWindow.rows.map(row => row.recordId));
    const history = [...sessionWindow.rows, ...conversationPages.rows.filter(row => !latestIds.has(row.recordId))]
      .filter((row) => !row.recordId.startsWith('thread:live-chat:')
        && !row.recordId.startsWith('addressed-exchange:')
        && !canonicalIds.has(row.recordId));
    return [...canonicalConversations.sessions, ...history]
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }, [canonicalConversations.sessions, sessionWindow.rows, conversationPages.rows]);
  const presets = useMemo<Preset[]>(
    () => decodeChatPresetsFeed(presetsEntry),
    [presetsEntry],
  );
  const currentProjectFeed = useMemo<ChatCurrentProjectFeed>(
    () => decodeChatCurrentProjectFeed(currentProjectEntry),
    [currentProjectEntry],
  );
  const placeableSurfaces = useMemo(
    () => readPlaceableSurfaces(placeableSurfacesEntry)
      .filter((surface) => !surface.disabled && surface.packageEntry),
    [placeableSurfacesEntry],
  );
  const workflowActions = useMemo(
    () => findChatWorkflowActions(readPublishedRecords(workflowActionRecordsEntry)),
    [workflowActionRecordsEntry],
  );
  // Live, per-app prompt-assembly override (#4). The SAME chat package runs in the
  // studio shell and in a coaching app; each app's log decides whether its
  // chat AI gets the placeable-surface capability / the work catalog. When a live
  // record exists it overrides the bundled package default; absent → bundled
  // (lean) default. This is why a coaching-app chat can let its AI place its surfaces
  // without touching studio plain chat.
  const livePromptAssembly = useMemo(
    () => readChatPromptAssembly(readPublishedRecords(chatOwnedRecordsEntry)),
    [chatOwnedRecordsEntry],
  );
  const liveResultPolicy = useMemo(
    () => readChatResultPolicy(readPublishedRecords(chatOwnedRecordsEntry), livePromptAssembly?.resultPolicyRef),
    [chatOwnedRecordsEntry, livePromptAssembly?.resultPolicyRef],
  );
  const liveTransitionPolicy = useMemo(
    () => readChatTransitionPolicy(readPublishedRecords(chatOwnedRecordsEntry), livePromptAssembly?.transitionDescriptorRef),
    [chatOwnedRecordsEntry, livePromptAssembly?.transitionDescriptorRef],
  );
  // DATA-driven message-annotation palette (#2 reaction authoring). The reaction
  // symbols and message actions (React/Pin/Star/Bookmark) are Society DATA read
  // from published-records — a new symbol or annotation kind is ONE palette row
  // and ZERO code (L090). Fail-closed: absent record -> empty arrays -> the
  // MessageAnnotations bar renders NO affordance (never invents symbols).
  const annotationPalette = useMemo(
    () => readMessageAnnotationPalette(readPublishedRecords(chatOwnedRecordsEntry)),
    [chatOwnedRecordsEntry],
  );
  const messageActions = useMemo(
    () => (recordActions?.length && onRecordAction ? [...annotationPalette.messageActions, ...recordActions] : annotationPalette.messageActions),
    [annotationPalette.messageActions, recordActions, onRecordAction],
  );
  const contextGrants = useMemo(
    () => decodeAddressedContextGrantsFeed(contextGrantsEntry),
    [contextGrantsEntry],
  );
  const selectedTextForNextAgentRequestEntry = useBitfieldData(
    'selected-text-for-next-agent-request',
  );
  const selection = useMemo<ChatSelectedTextForNextAgentRequest | null>(
    () => decodeChatSelectedTextForNextAgentRequestFeed(selectedTextForNextAgentRequestEntry),
    [selectedTextForNextAgentRequestEntry],
  );
  // The selection is silently folded into the next send (materializeAddressedExchange).
  // Surface it as a read-only composer chip so the user can SEE what context is
  // attached; it mirrors live selection state and clears when the selection clears.
  const selectedContext = useMemo(
    () =>
      selection
        ? { label: selection.title || 'Selected text', excerpt: selection.selectedText?.slice(0, 80) }
        : null,
    [selection],
  );

  const [activeSessionId, setTabSession] = useState<string | null>(null);
  const embeddedFocusConversation = focusConversationKey(surfaceInput);
  const embeddedFocusSession = useMemo(() => sessions.find((session) =>
    session.recordId === embeddedFocusConversation
    || session.sessionId === embeddedFocusConversation
    || (embeddedFocusConversation && session.recordId.endsWith(`:${embeddedFocusConversation}`))),
  [embeddedFocusConversation, sessions]);
  const embeddedFocusConversationAppliedRef = useRef('');
  useEffect(() => {
    if (!embeddedFocusConversation) {
      embeddedFocusConversationAppliedRef.current = '';
      return;
    }
    if (embeddedFocusConversationAppliedRef.current === embeddedFocusConversation) return;
    // An addressed conversation may arrive after the preview window. Never invent a thread or mark the focus
    // applied until its real row is present; otherwise a late row can never resolve the selected destination.
    if (!embeddedFocusSession) { setTabSession(null); return; }
    embeddedFocusConversationAppliedRef.current = embeddedFocusConversation;
    setTabSession(embeddedFocusSession.recordId);
  }, [embeddedFocusConversation, embeddedFocusSession]);
  // The decoder session-id is a DISTINCT concept from the UI tab-key. For
  // source-backed threads the tab-key (recordId) is the mapper thread_ref
  // (`thread:<source_ref>:<guid>`) while every decoder-bound read matches on the
  // raw session id (`sessionId`) — the source decoder's own vocabulary (L098).
  // Conflating them made source transcripts render empty (decode_window's
  // `WHERE guid = ?` missed the prefixed thread_ref). Resolve the canonical
  // decoder id from the session record and route ALL decoder dispatches through
  // it — never the tab-key. This eliminates the category, not the iMessage
  // instance: it holds for any source whose thread_ref differs from its raw id.
  const activeDecoderSessionId = useMemo(
    () => typeof surfaceInput?.transcriptSessionId === 'string' && activeSessionId === embeddedFocusSession?.recordId
      ? surfaceInput.transcriptSessionId : resolveDecoderSessionId(activeSessionId, sessions),
    [activeSessionId, sessions, surfaceInput?.transcriptSessionId, embeddedFocusSession?.recordId],
  );
  const currentTranscriptSession = useRef(activeDecoderSessionId);
  currentTranscriptSession.current = activeDecoderSessionId;
  const selectedMessageWindowEntry = useBitfieldData({
    input: 'selected-chat-message-window',
    params: {
      sessionId: activeDecoderSessionId,
    },
  });
  const selectedMessageWindow = useMemo(
    () => decodeActiveChatMessageWindowPayload(selectedMessageWindowEntry),
    [selectedMessageWindowEntry],
  );
  // SSOT (L030/L063): the transcript workflow's `publish` step writes the decoded
  // page to the PER-SESSION address `selected-chat-message-window:<sessionId>:latest`
  // — the same address `selectedMessageWindow` above reads — so every open thread
  // renders from its OWN window. The former global singleton `chat-active-transcript`
  // was one shared mutable address serving N threads: whichever thread's slow publish
  // landed last won the render, so clicking a second thread "stuck on the first". That
  // address is deleted; there is exactly one render source, keyed by session.
  // In-app conversations persist canonical Conversations turns, not transcript
  // files. The projection and this stream share one package owner, so the open
  // thread and sidebar converge without a Chat-owned ledger.

  const [activePreset, setActivePreset] = useState<{ label: string; prompt: string; description?: string } | null>(null);
  const [pendingConversation, setPendingConversation] = useState<PendingConversation | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [producerTurn, setProducerTurn] = useState<ProducerTurn | null>(null);
  const producerResultEntry = useBitfieldData({
    input: 'producer-record-by-address-label',
    params: { addressLabel: producerTurn?.submission.resultAddress ?? 'package::chat::producer-result::none' },
  });
  const producerErrorEntry = useBitfieldData({
    input: 'producer-record-by-address-label',
    params: { addressLabel: producerTurn?.submission.errorAddress ?? 'package::chat::producer-error::none' },
  });
  const producerStatus = useMemo(
    () => readChatProducerStatusFromEntries(producerResultEntry, producerErrorEntry),
    [producerErrorEntry, producerResultEntry],
  );
  const [inFlightCapability, setInFlightCapability] = useState<InFlightCapabilityDispatch | null>(null);
  const [liveTurn, setLiveTurn] = useState<LiveChatTurn | null>(null);
  const liveTurnRef = useRef<LiveChatTurn | null>(null);
  const finalizingLiveTurnRef = useRef<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrySendContent, setRetrySendContent] = useState<string | null>(null);
  const retrySendAttemptRef = useRef<(() => Promise<void>) | null>(null);
  const [retryProviderSelection, setRetryProviderSelection] = useState<string | null>(null);
  // Optimistic outbound bubbles for channel sends (iMessage etc.). Each entry is
  // scoped to the thread it was sent into and shown until the canonical transcript
  // absorbs the native echo (is_from_me=1). This overlay is deliberately decoupled
  // from the AI producer path (pendingConversation) — a channel send runs no
  // producer, no live turn, no polling; it is one egress dispatch plus this bubble.
  const [outboundEchoes, setOutboundEchoes] = useState<{ sessionId: string; message: AgentMessage }[]>([]);
  // Optimistic viewer reactions for the active thread. A tap renders the
  // annotation IMMEDIATELY at provenance 0 (speaker 'me'), before the durable
  // ledger write returns; the async write converges it. On write failure the
  // entry is dropped (fail-closed) so the UI never shows an annotation the log
  // did not accept. Keyed by (sessionId, atomRef, symbol, intentKind); a
  // 'removed' toggle drops the matching optimistic 'added'.
  const [optimisticReactions, setOptimisticReactions] = useState<{
    sessionId: string;
    atomRef: string;
    symbol: string;
    intentKind: string;
    reaction: MessageReaction;
  }[]>([]);
  // Keep the exact event identity and time while a save is unresolved. A deliberate
  // removal is a different key and remains a separate append-only event.
  const intentRetriesRef = useRef(new Map<string, { intentId: string; at: Date; capability: ConversationSendCapability | null }>());
  const [transcriptPage, setTranscriptPage] = useState<ChatTranscriptPage | null>(null);
  const [transcriptPageLoading, setTranscriptPageLoading] = useState(false);
  const [transcriptVisit, setTranscriptVisit] = useState(0);
  const [transcriptPageError, setTranscriptPageError] = useState<string | null>(null);
  const participantRegistryEntry = useBitfieldData('addressed-exchange-participants');
  const addressedParticipants = useMemo<AddressedParticipantInfo[]>(
    () => decodeAddressedParticipantsFeed(participantRegistryEntry),
    [participantRegistryEntry],
  );
  // The complete CLI registry remains execution-only. The human catalog below
  // projects ai-agent-profile identities; transport rows never become UI just
  // because they are executable.
  const cliRegistryEntry = useBitfieldData('cli-registry');
  const cliRegistryParticipants = useMemo<AddressedParticipantInfo[]>(
    () => decodeCliRegistryParticipants(cliRegistryEntry),
    [cliRegistryEntry],
  );
  const agentProfileEntry = useBitfieldData('agent-profile-participants');
  const modelDescriptors = useBitfieldData('chat-model-descriptors');
  const modelDescriptorsRef = useRef(modelDescriptors);
  modelDescriptorsRef.current = modelDescriptors;
  useEffect(() => {
    void refreshChatModelInventory().catch(() => { /* No current fact means no available models. */ });
  }, []);
  const agentProfileParticipants = useMemo<AddressedParticipantInfo[]>(
    () => decodeAgentProfileParticipants(agentProfileEntry, { descriptors: modelDescriptors }),
    [agentProfileEntry, modelDescriptors],
  );
  const presentedAgentParticipants = useMemo(
    () => chooseAgentPresentationParticipants(cliRegistryParticipants, agentProfileParticipants),
    [agentProfileParticipants, cliRegistryParticipants],
  );
  const [chatConfig, setChatConfig] = useState<ChatSessionConfig>(INITIAL_CHAT_CONFIG);
  const [isParticipantBrowserOpen, setIsParticipantBrowserOpen] = useState(false);
  const [pendingSetupForm, setPendingSetupForm] = useState<PendingSetupForm | null>(null);
  const activeSessionConfigSyncRef = useRef<string | null>(null);
  // Mode is fixed to 'chat'. The AI Work / Idea mode pill was removed from the
  // composer (both empty-state and stream), so there is no in-UI mode switch.
  const [inputMode] = useState<InputMode>('chat');
  const [isPlanSidebarOpen, setIsPlanSidebarOpen] = useState(false);

  useEffect(() => {
    liveTurnRef.current = liveTurn;
  }, [liveTurn, workflowActions]);

  const liveProcessSessionEventsEntry = useBitfieldData({
    input: 'liveProcessSessionEvents',
    params: {
      eventsAddress: liveTurn?.processSessionEventsAddress ?? null,
    },
  });
  const liveProcessSessionEvents = liveProcessSessionEventsEntry instanceof Uint8Array
    ? liveProcessSessionEventsEntry
    : undefined;

  // V2 feed contract: the feed address serves a constant-size HEAD whose
  // event_stream_address names the per-event delta stream. Discover it from
  // the head and subscribe alongside; V1 payloads carry events inline and
  // produce no stream address (head stays null → params null → no-op).
  const liveProcessSessionHead = useMemo(
    () => (liveProcessSessionEvents ? readProcessSessionEventHead(liveProcessSessionEvents) : null),
    [liveProcessSessionEvents],
  );
  const liveProcessSessionEventStreamEntry = useBitfieldData({
    input: 'liveProcessSessionEvents',
    params: {
      eventsAddress: liveProcessSessionHead?.eventStreamAddress ?? null,
    },
  });
  const liveProcessSessionEventStream = liveProcessSessionEventStreamEntry instanceof Uint8Array
    ? liveProcessSessionEventStreamEntry
    : undefined;

  const applyProcessSessionEvents = useCallback((feed: Uint8Array | ProcessSessionEventsFeedView, current: LiveChatTurn) => {
    // Delta payloads (V3) carry ONE event — output text APPENDS to the
    // existing turn instead of replacing it. Full feeds (V1) and heads (V2)
    // replace: V1 rebuilds from the entire inline history; V2 heads carry no
    // output bytes, so replacement is state-only (output guard below).
    const isDeltaPayload = feed instanceof Uint8Array && isProcessSessionEventDeltaPayload(feed);
    let snapshot: LiveProcessSessionEventSnapshot;
    try {
      snapshot = decodeLiveProcessSessionSnapshot(
        typeof feed === 'object' && 'forEachEvent' in feed
          ? feed
          : readProcessSessionEventsFeed(feed),
        current.processSessionId,
        current.state,
        current.exitCode,
        current.failureReason,
      );
    } catch (error) {
      console.error('[chat] decode process-session event feed failed:', error);
      setActionError('Failed to load message.');
      return;
    }

    setLiveTurn((existing) => {
      if (!existing || existing.processSessionId !== current.processSessionId) return existing;
      if (snapshot.matchedEventCount === 0 && existing.lastEventNumber > 0) return existing;
      if (isDeltaPayload) {
        // Replayed or reordered delta — already folded into the turn.
        if (snapshot.lastEventNumber <= existing.lastEventNumber) return existing;
        snapshot = {
          ...snapshot,
          outputText: existing.outputText + snapshot.outputText,
        };
      } else if (snapshot.outputText.length === 0 && existing.outputText.length > 0) {
        // Head/state-only payload — never erase accumulated delta output.
        snapshot = { ...snapshot, outputText: existing.outputText };
      }
      if (
        existing.outputText === snapshot.outputText
        && existing.lastEventNumber === snapshot.lastEventNumber
        && existing.state === snapshot.state
        && existing.exitCode === snapshot.exitCode
        && existing.failureReason === snapshot.failureReason
      ) {
        return existing;
      }
      logLiveTurnDiagnostic('event-feed-snapshot', {
        processSessionId: existing.processSessionId,
        elapsedMs: elapsedMsSince(existing.startedAtMs),
        matchedEventCount: snapshot.matchedEventCount,
        lastEventNumber: snapshot.lastEventNumber,
        state: snapshot.state,
        exitCode: snapshot.exitCode,
        outputTextLength: snapshot.outputText.length,
        failureReason: snapshot.failureReason,
      });
      const nextSnapshot = {
        outputText: snapshot.outputText,
        lastEventNumber: snapshot.lastEventNumber,
        state: snapshot.state,
        exitCode: snapshot.exitCode,
        failureReason: snapshot.failureReason,
      };
      return { ...existing, ...nextSnapshot };
    });
  }, []);

  useEffect(() => {
    if (!liveTurn || !liveProcessSessionEvents) return;
    const current = liveTurnRef.current;
    if (!current || current.processSessionId !== liveTurn.processSessionId) return;
    applyProcessSessionEvents(liveProcessSessionEvents, current);
  }, [
    applyProcessSessionEvents,
    liveProcessSessionEvents,
    liveTurn?.processSessionId,
  ]);

  useEffect(() => {
    if (!liveTurn || !liveProcessSessionEventStream) return;
    const current = liveTurnRef.current;
    if (!current || current.processSessionId !== liveTurn.processSessionId) return;
    applyProcessSessionEvents(liveProcessSessionEventStream, current);
  }, [
    applyProcessSessionEvents,
    liveProcessSessionEventStream,
    liveTurn?.processSessionId,
  ]);

  // Routing keeps every executable transport for historical/open conversations.
  // Presentation is a separate projection: configured profiles supersede raw
  // provider processes, while addressed people remain selectable. Both merge
  // through the same participant contract and neither imports another owner.
  const availableParticipants = useMemo(() => {
    return mergeAgentSelectionParticipants([
      ...agentProfileParticipants,
      ...cliRegistryParticipants,
      ...addressedParticipants,
    ]);
  }, [cliRegistryParticipants, agentProfileParticipants, addressedParticipants]);
  const explicitParticipantRef = typeof surfaceInput?.participantRef === 'string'
    ? surfaceInput.participantRef.trim()
    : '';
  const defaultParticipantRef = typeof surfaceInput?.defaultParticipantRef === 'string'
    ? surfaceInput.defaultParticipantRef.trim() : '';
  const assistantLabel = typeof surfaceInput?.assistantLabel === 'string'
    ? surfaceInput.assistantLabel.trim() : '';
  const presentedParticipants = useMemo(() => {
    const participants = mergeAgentSelectionParticipants([...presentedAgentParticipants, ...addressedParticipants]);
    const primaryRef = defaultParticipantRef || explicitParticipantRef
      || participants.find(participant => participant.adapter?.ownerTargetRef)?.participantRef;
    return assistantLabel && primaryRef
      ? participants.map(participant => participant.participantRef === primaryRef
        ? { ...participant, label: assistantLabel } : participant)
      : participants;
  }, [addressedParticipants, presentedAgentParticipants, explicitParticipantRef, defaultParticipantRef, assistantLabel]);

  useEffect(() => {
    // SSOT ownership arbitration (L055/L063): this default-participant normalizer
    // is the SOLE writer of chatConfig ONLY while the provider selection is
    // actually editable — meaning no conversation is open, no send is locked, and
    // no turn is in flight. Once a conversation is open, the active-session sync
    // effect below owns chatConfig and mirrors the opened thread's route ref,
    // which for a channel-routed thread (telegram / whatsapp / discord / imessage /
    // any future channel) is never a member of the editable presentation catalog. Without
    // this boundary the two effects fight over chatConfig.participantRef every
    // render (this effect resets it to a visible profile ref; the sync effect rewrites the
    // channel ref) and React aborts the render loop (#185). We reuse the same
    // canChangeChatProviderSelection predicate the picker UI reads, so both
    // readers share ONE definition of "selection is editable" (SSOT). This stays
    // blind to channel identity — a new channel/account is pure DATA, zero edits.
    if (!canChangeChatProviderSelection({
      activeSessionId,
      pendingConversationLedgerId: pendingConversation?.ledgerConversationId ?? null,
      hasPendingConversation: Boolean(pendingConversation),
      isProcessing,
    })) {
      return;
    }

    if (presentedParticipants.length === 0) {
      if (chatConfig.participantRefs.length > 0 || chatConfig.participantRef || chatConfig.accountId || chatConfig.model) {
        setChatConfig(INITIAL_CHAT_CONFIG);
      }
      return;
    }

    const currentParticipantRefs =
      chatConfig.participantRefs.length > 0
        ? chatConfig.participantRefs
        : [chatConfig.participantRef].filter(Boolean);
    const presentedParticipantRefSet = new Set(
      presentedParticipants.map((participant) => participant.participantRef),
    );
    const supportedCurrentParticipantRefs = currentParticipantRefs.filter(
      (participantRef) => presentedParticipantRefSet.has(participantRef),
    );
    const firstParticipant = defaultParticipantRef
      ? presentedParticipants.find((participant) => participant.participantRef === defaultParticipantRef)
      : presentedParticipants.find((participant) => participant.adapter?.ownerTargetRef) ?? presentedParticipants[0];
    const resolvedParticipantRefs = resolveEditableParticipantRefs({
      availableParticipantRefs: presentedParticipants.map(
        (participant) => participant.participantRef,
      ),
      currentParticipantRefs,
      explicitParticipantRef,
      defaultParticipantRef: firstParticipant?.participantRef,
    });

    if (resolvedParticipantRefs.length === 0) {
      if (
        chatConfig.participantRefs.length > 0
        || chatConfig.participantRef
        || chatConfig.accountId
        || chatConfig.model
      ) {
        setChatConfig(INITIAL_CHAT_CONFIG);
      }
      return;
    }

    const primaryParticipantRef = resolvedParticipantRefs[0];
    const participant = presentedParticipants.find(
      (entry) => entry.participantRef === primaryParticipantRef,
    );
    if (
      resolvedParticipantRefs.length === chatConfig.participantRefs.length
      && resolvedParticipantRefs.every(
        (participantRef, index) =>
          participantRef === chatConfig.participantRefs[index],
      )
      && primaryParticipantRef === chatConfig.participantRef
    ) {
      return;
    }

    if (
      !explicitParticipantRef
      && supportedCurrentParticipantRefs.length > 0
    ) {
      if (
        resolvedParticipantRefs.length !== chatConfig.participantRefs.length
        || primaryParticipantRef !== chatConfig.participantRef
      ) {
        setChatConfig((prev) => normalizeChatSessionConfig({
          ...prev,
          participantRefs: resolvedParticipantRefs,
        }));
      }
      return;
    }

    setChatConfig(normalizeChatSessionConfig({
      participantRefs: resolvedParticipantRefs,
      accountId: explicitParticipantRef ? '' : participant?.accounts[0]?.id ?? '',
      model: getAddressedParticipantDefaultModelId(
        presentedParticipants,
        primaryParticipantRef,
      ),
    }));
  }, [activeSessionId, pendingConversation, isProcessing, presentedParticipants, explicitParticipantRef, defaultParticipantRef, chatConfig.accountId, chatConfig.participantRef, chatConfig.participantRefs, chatConfig.model]);

  const availableAccounts = useMemo(() => {
    const participant = presentedParticipants.find((entry) => entry.participantRef === chatConfig.participantRef);
    return participant ? participant.accounts : EMPTY_ACCOUNTS;
  }, [presentedParticipants, chatConfig.participantRef]);

  const availableModels = useMemo<readonly AddressedParticipantModelOption[]>(
    () => getAddressedParticipantModels(presentedParticipants, chatConfig.participantRef),
    [presentedParticipants, chatConfig.participantRef],
  );

  useEffect(() => {
    if (availableAccounts.length === 0) {
      if (chatConfig.accountId) {
        setChatConfig((prev) => ({ ...prev, accountId: '' }));
      }
      return;
    }

    const hasSelectedAccount = availableAccounts.some((account) => account.id === chatConfig.accountId);
    if (hasSelectedAccount) return;

    setChatConfig((prev) => ({ ...prev, accountId: availableAccounts[0].id }));
  }, [availableAccounts, chatConfig.accountId]);

  useEffect(() => {
    // A vanished route is an unavailable selection, never permission to silently
    // replace the model attached to an existing conversation or failed attempt.
    if (chatConfig.model || availableModels.length === 0 || activeSessionId || pendingConversation || isProcessing) return;
    setChatConfig((prev) => prev.model ? prev : ({ ...prev,
      model: getAddressedParticipantDefaultModelId(presentedParticipants, prev.participantRef) }));
  }, [presentedParticipants, availableModels, chatConfig.model, activeSessionId, pendingConversation, isProcessing]);

  const savedModelBasisRef = useRef<{ participant: string; models: string } | null>(null);
  useEffect(() => {
    const selected = presentedParticipants.find(p => p.participantRef === chatConfig.participantRef);
    const refs = selected?.metadata?.configuredModelRefs;
    if (!Array.isArray(refs)) return;
    const basis = { participant: chatConfig.participantRef, models: JSON.stringify(refs) };
    const prior = savedModelBasisRef.current;
    savedModelBasisRef.current = basis;
    if (!prior || prior.participant !== basis.participant || prior.models === basis.models
      || activeSessionId || pendingConversation || isProcessing || retrySendAttemptRef.current) return;
    // A saved profile edit governs a fresh draft; retained attempts keep their
    // captured model and request identity even if the profile changes later.
    setChatConfig(prev => ({ ...prev, model: typeof refs[0] === 'string' ? refs[0] : null }));
  }, [presentedParticipants, chatConfig.participantRef, activeSessionId, pendingConversation, isProcessing]);

  const setParticipant = useCallback((participantRef: string) => {
    setChatConfig((prev) => {
      const existingRefs = prev.participantRefs.length > 0 ? prev.participantRefs : [prev.participantRef].filter(Boolean);
      const participantRefs = existingRefs.includes(participantRef)
        ? existingRefs.filter((ref) => ref !== participantRef)
        : [...existingRefs, participantRef];
      const nextPrimaryRef = participantRefs[0] ?? '';
      const participant = presentedParticipants.find((entry) => entry.participantRef === nextPrimaryRef);
      return normalizeChatSessionConfig({
        participantRefs,
        accountId: participant?.accounts[0]?.id ?? '',
        model: nextPrimaryRef ? getAddressedParticipantDefaultModelId(presentedParticipants, nextPrimaryRef) : null,
      });
    });
  }, [presentedParticipants]);

  // Unified picker: pin exactly one agent + model (single-select), defaulting the
  // model when none is given. Account follows the agent's first account.
  const selectAgentAndModel = useCallback((participantRef: string, modelId: string | null) => {
    setChatConfig(() => {
      const participant = presentedParticipants.find((entry) => entry.participantRef === participantRef);
      return normalizeChatSessionConfig({
        participantRefs: [participantRef],
        accountId: participant?.accounts[0]?.id ?? '',
        model: modelId ?? getAddressedParticipantDefaultModelId(presentedParticipants, participantRef),
      });
    });
    // The participant ref is the profile identity from DATA. The execution
    // owner resolves its route without exposing the transport as presentation.
    setRetryProviderSelection(null);
    void setSelectedAgent(participantRef).catch((error) => {
      console.error('[chat] participant selection failed:', error instanceof Error ? error.message : String(error));
      setRetryProviderSelection(participantRef);
      setActionError('Your assistant choice could not be saved. Try again.');
    });
  }, [presentedParticipants]);

  // Unified picker: clear the explicit choice so the system resolves the default
  // agent + model ("Auto"). The brain decides — the user picks nothing.
  const selectAutoAgent = useCallback(() => {
    setChatConfig(() => normalizeChatSessionConfig({ participantRefs: [], accountId: '', model: null }));
    // Clear the SSOT so the producer falls back to the provider-primary default.
    setRetryProviderSelection(null);
    void setSelectedAgent('').catch((error) => {
      console.error('[chat] automatic participant selection failed:', error instanceof Error ? error.message : String(error));
      setRetryProviderSelection('');
      setActionError('Your assistant choice could not be saved. Try again.');
    });
  }, []);

  const handleRetryProviderSelection = useCallback(() => {
    if (retryProviderSelection === null) return;
    const participantRef = retryProviderSelection;
    setActionError(null);
    void setSelectedAgent(participantRef).then(() => {
      setRetryProviderSelection(null);
    }).catch((error) => {
      console.error('[chat] participant selection retry failed:', error instanceof Error ? error.message : String(error));
      setActionError('Your assistant choice could not be saved. Try again.');
    });
  }, [retryProviderSelection]);

  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.recordId, session])),
    [sessions],
  );
  const participantInfoByRef = useMemo(
    () => new Map(availableParticipants.map((participant) => [participant.participantRef, participant])),
    [availableParticipants],
  );
  const activeSession = activeSessionId ? sessionById.get(activeSessionId) ?? null : null;
  useEffect(() => {
    if (!activeSession) {
      activeSessionConfigSyncRef.current = null;
      return;
    }

    const activeSessionParticipantRefs = activeSession.participantRefs.length > 0
      ? activeSession.participantRefs
      : [activeSession.participantRef].filter(Boolean);
    const activeSessionPrimaryParticipantRef = activeSessionParticipantRefs[0] ?? activeSession.participantRef;
    const syncKey = [
      activeSession.recordId,
      activeSessionParticipantRefs.join('\u0001'),
      activeSession.accountDir ?? '',
    ].join('\u0000');
    if (
      activeSessionConfigSyncRef.current === syncKey
      && chatConfig.participantRef === activeSessionPrimaryParticipantRef
      && chatConfig.participantRefs.join('\u0001') === activeSessionParticipantRefs.join('\u0001')
    ) return;

    const participantInfo = availableParticipants.find((participant) => participant.participantRef === activeSessionPrimaryParticipantRef);
    const account = findAddressedParticipantAccount(participantInfo, null, activeSession.accountDir);
    const model = activeSession.model ?? getAddressedParticipantDefaultModelId(availableParticipants, activeSessionPrimaryParticipantRef);
    const accountId = account?.id ?? activeSession.accountDir ?? '';

    activeSessionConfigSyncRef.current = syncKey;
    setChatConfig((current) => (
      current.participantRef === activeSessionPrimaryParticipantRef
      && current.participantRefs.join('\u0001') === activeSessionParticipantRefs.join('\u0001')
      && current.accountId === accountId
      && current.model === model
        ? current
        : normalizeChatSessionConfig({
          participantRefs: activeSessionParticipantRefs,
          accountId,
          model,
        })
    ));
  }, [
    activeSession,
    availableParticipants,
    chatConfig.participantRef,
    chatConfig.participantRefs,
  ]);
  // The per-session window is DECODER-scoped: its session_id is the raw decoder id
  // (prop:session_transcript:session_id == the `sessionId` param, which is
  // activeDecoderSessionId), NOT the prefixed tab-key. Match it to the decoder id.
  // Matching activeSessionId (`thread:<ref>:<guid>`) is ALWAYS false for source
  // threads whose thread_ref differs from their raw id, which would silently discard
  // the window — so new inbound messages in an OPEN thread would only appear on
  // reopen. Same L098 category as the decoder-session-id read fix: every decoder-
  // scoped read matches the decoder id, never the tab-key. In-app/unknown threads
  // have no materialized source window, and there activeDecoderSessionId ===
  // activeSessionId anyway, so there is no behavior change for them. This per-session
  // window is now the SOLE render source (the shared `chat-active-transcript`
  // singleton that caused "stuck on the first clicked thread" is deleted).
  const selectedWindowForActiveSession = selectedMessageWindow?.session_id === activeDecoderSessionId
    ? selectedMessageWindow
    : null;
  const activeSessionProjectPath = activeSession?.projectPath
    ?? (activeSession?.filePath
    && (transcriptPage ?? selectedWindowForActiveSession)?.project_path
    && (!(transcriptPage ?? selectedWindowForActiveSession)?.file_path || (transcriptPage ?? selectedWindowForActiveSession)?.file_path === activeSession.filePath)
    ? (transcriptPage ?? selectedWindowForActiveSession)?.project_path
    : null);
  const selectedTranscriptPage = transcriptPage ?? selectedWindowForActiveSession;
  const selectedTranscriptMessageCount = selectedTranscriptPage?.total_count ?? selectedTranscriptPage?.lines.length ?? 0;
  const canonicalMessagesForActiveSession = useMemo(
    () => (activeSessionId ? canonicalConversations.messagesBySession[activeSessionId] ?? [] : []),
    [canonicalConversations.messagesBySession, activeSessionId],
  );
  const selectedWindowMessages = useMemo(() => {
    const pageMessages = selectedTranscriptPage ? transcriptLinesToAgentMessages(selectedTranscriptPage.lines) : [];
    // File-backed (CLI/iMessage scan) threads render from the transcript page; an
    // in-app thread renders its canonical Conversations projection.
    return pageMessages.length > 0 ? pageMessages : canonicalMessagesForActiveSession;
  }, [selectedTranscriptPage, canonicalMessagesForActiveSession]);
  const canonicalMessages = selectCanonicalChatMessages({
    selectedWindowMessages,
    selectedWindowLoading: Boolean(activeSession?.filePath) && (transcriptPageLoading || !selectedTranscriptPage),
    selectedWindowError: activeSession?.filePath
      ? transcriptPageError ?? (!transcriptPageLoading && selectedTranscriptPage
        && !(selectedTranscriptPage.total_count_known && selectedTranscriptPage.total_count === 0)
        && selectedWindowMessages.length === 0
        ? 'This conversation could not be loaded. Try opening it again.' : null)
      : null,
    loadingMessageId: `transcript-loading:${activeSessionId ?? activeSession?.filePath ?? 'none'}`,
    loadingTimestamp: activeSession?.lastActivityAt ?? new Date().toISOString(),
  });
  const surfaceSeedMessage = useMemo<AgentMessage[]>(() => {
    if (canonicalMessages.length > 0) return [];
    const content = typeof surfaceInput?.initialAssistantMessage === 'string'
      ? surfaceInput.initialAssistantMessage.trim()
      : '';
    if (!content) return [];
    return [{
      id: `surface-seed:${embeddedFocusConversation || 'conversation'}`,
      type: 'text',
      role: 'assistant',
      content,
      timestamp: typeof surfaceInput?.initialAssistantMessageAt === 'string'
        ? surfaceInput.initialAssistantMessageAt
        : new Date().toISOString(),
    }];
  }, [canonicalMessages.length, embeddedFocusConversation, surfaceInput]);
  const liveAgentMessages = useMemo<AgentMessage[]>(() => {
    if (!liveTurn) return [];

    const liveMessages = extractLiveAgentMessages(
      liveTurn.outputText,
      liveTurn.input.adapter.streamParseSpec ?? EMPTY_STREAM_PARSE_SPEC,
      liveTurn.startedAt,
    );
    if (liveMessages.length === 0) {
      if (liveTurn.state !== 'running') return [];
      return [{
        id: `live-status:${liveTurn.processSessionId}`,
        type: 'status',
        content: 'Working on your request…',
        role: 'assistant',
        timestamp: liveTurn.startedAt,
      }];
    }

    return liveMessages;
  }, [
    liveTurn?.outputText,
    liveTurn?.processSessionId,
    liveTurn?.startedAt,
    liveTurn?.state,
  ]);

  const producerAgentMessages = useMemo<AgentMessage[]>(() => {
    if (!producerTurn) return [];
    // The tool-call trail itself lives in the conversation flow (pendingConversation,
    // in correct order before the answer). Here we render only the transient working
    // indicator so a multi-step (tool) turn NEVER looks idle — round-aware so the user
    // can tell thinking-vs-composing-after-a-tool apart.
    if (producerTurn.state === 'error') {
      return [{
        id: `producer-error:${producerTurn.requestId}`,
        type: 'status',
        content: producerTurn.errorMessage || 'I could not complete that request.',
        role: 'assistant',
        timestamp: producerTurn.startedAt,
      }];
    }
    if (producerTurn.state !== 'pending') return [];
    const working = producerTurn.toolRound > 0
      ? 'Putting the result together…'
      : 'Working…';
    return [{
      id: `producer-pending:${producerTurn.requestId}`,
      type: 'status',
      content: working,
      role: 'assistant',
      timestamp: producerTurn.startedAt,
    }];
  }, [
    producerTurn?.requestId,
    producerTurn?.startedAt,
    producerTurn?.state,
    producerTurn?.toolRound,
  ]);

  const pendingConversationAbsorbed = useMemo(() => {
    if (!pendingConversation) return false;
    if (pendingConversation.recordId !== activeSessionId) return false;
    if (liveTurn?.state === 'running') return false;
    return pendingMessagesAbsorbedByCanonical(canonicalMessages, pendingConversation.messages);
  }, [
    activeSessionId,
    canonicalMessages,
    liveTurn?.state,
    pendingConversation,
  ]);

  const shouldOverlayPending = useMemo(() => {
    if (!pendingConversation) return false;
    if (!activeSessionId) return true;
    if (pendingConversation.recordId !== activeSessionId) return false;
    if (pendingConversationAbsorbed) return false;
    const currentCount = selectedTranscriptMessageCount;
    return currentCount <= pendingConversation.baselineMessageCount;
  }, [
    activeSessionId,
    pendingConversation,
    pendingConversationAbsorbed,
    selectedTranscriptMessageCount,
  ]);

  // Optimistic outbound bubbles for the active thread, minus any the canonical
  // transcript already carries (native is_from_me echo arrived). Absorption is by
  // exact body match on a human-role canonical message; the reconciliation task
  // upgrades this to id/observation correlation, but text-match keeps a delivered
  // message from rendering twice in the meantime.
  const activeOutboundEchoes = useMemo(() => {
    if (!activeSessionId) return [] as AgentMessage[];
    const canonicalHumanTexts = new Set(
      canonicalMessages.filter((message) => message.role === 'human').map((message) => message.content),
    );
    return outboundEchoes
      .filter((entry) => entry.sessionId === activeSessionId && !canonicalHumanTexts.has(entry.message.content))
      .map((entry) => entry.message);
  }, [activeSessionId, canonicalMessages, outboundEchoes]);

  // Once the canonical transcript for the active thread carries the native echo,
  // drop the optimistic bubble from state so it can't accumulate across sends.
  useEffect(() => {
    if (!activeSessionId) return;
    const canonicalHumanTexts = new Set(
      canonicalMessages.filter((message) => message.role === 'human').map((message) => message.content),
    );
    setOutboundEchoes((prev) => {
      const next = prev.filter((entry) => !(entry.sessionId === activeSessionId && canonicalHumanTexts.has(entry.message.content)));
      return next.length === prev.length ? prev : next;
    });
  }, [activeSessionId, canonicalMessages]);

  const messages = useMemo(() => {
    const pendingMessages = pendingConversation
      ? [...pendingConversation.messages, ...liveAgentMessages, ...producerAgentMessages]
      : [...liveAgentMessages, ...producerAgentMessages];
    if (activeSessionId) {
      const canonicalOrSeed = canonicalMessages.length > 0 ? canonicalMessages : surfaceSeedMessage;
      const base = shouldOverlayPending && pendingConversation
        ? [...canonicalOrSeed, ...pendingMessages]
        : canonicalOrSeed;
      return activeOutboundEchoes.length > 0 ? [...base, ...activeOutboundEchoes] : base;
    }
    return pendingMessages;
  }, [activeSessionId, activeOutboundEchoes, canonicalMessages, liveAgentMessages, pendingConversation, producerAgentMessages, shouldOverlayPending, surfaceSeedMessage]);
  // Active-thread optimistic reactions, then fold them onto the matching message
  // by atomRef so a tapped annotation renders instantly (provenance 0, 'me').
  // Only messagesForPanel carries reactions — SessionMetaBar/plan parsing use the
  // un-decorated `messages` (reactions are irrelevant there).
  const activeOptimisticReactions = useMemo(
    () => (activeSessionId
      ? optimisticReactions.filter((entry) => entry.sessionId === activeSessionId)
      : []),
    [activeSessionId, optimisticReactions],
  );
  const messagesForPanel = useMemo(() => {
    if (activeOptimisticReactions.length === 0) return messages;
    const byAtom = new Map<string, MessageReaction[]>();
    for (const entry of activeOptimisticReactions) {
      const list = byAtom.get(entry.atomRef) ?? [];
      list.push(entry.reaction);
      byAtom.set(entry.atomRef, list);
    }
    return messages.map((message) => {
      if (!message.atomRef) return message;
      const extra = byAtom.get(message.atomRef);
      if (!extra || extra.length === 0) return message;
      return { ...message, reactions: [...(message.reactions ?? []), ...extra] };
    });
  }, [messages, activeOptimisticReactions]);

  // #2 reaction authoring: a viewer intent on a message subject atom. Renders the
  // annotation optimistically (provenance 0), writes it to the durable viewer
  // intent ledger, and forwards real egress ONLY when the source declares a
  // reactCapability (absent for iMessage -> the durable annotation is the whole
  // effect, never a fake tapback). Reaction is one config; pin/star/bookmark ride
  // this SAME path via DATA (L069/L090) — zero per-kind code here.
  const handleMessageIntent = useCallback((intent: MessageIntent) => {
    if (onRecordAction && recordActions?.some((action) => action.intentKind === intent.intentKind)) { onRecordAction(intent); return; }
    const threadRef = activeSession?.recordId;
    if (!threadRef || !intent.targetAtomRef) return;
    const intentKind = intent.intentKind || 'reaction';
    const symbol = intent.symbol ?? intentKind;
    const reactionKind = intent.reactionKind ?? 'added';
    const retryKey = JSON.stringify([threadRef, intent.targetAtomRef, intentKind, symbol, reactionKind]);
    if (intentKind === 'reaction') {
      const opposite = reactionKind === 'removed' ? 'added' : 'removed';
      intentRetriesRef.current.delete(JSON.stringify([threadRef, intent.targetAtomRef, intentKind, symbol, opposite]));
    }
    const retry = intentRetriesRef.current.get(retryKey) ?? { intentId: `intent:${globalThis.crypto.randomUUID()}`, at: new Date(), capability: activeSession?.reactCapability ?? null };
    intentRetriesRef.current.set(retryKey, retry);
    const optimistic = {
      sessionId: threadRef,
      atomRef: intent.targetAtomRef,
      symbol,
      intentKind,
      reaction: {
        atomRef: intent.targetAtomRef,
        symbol,
        reactionKind,
        speaker: 'me',
        at: retry.at.toISOString(),
      } as MessageReaction,
    };
    setOptimisticReactions((prev) => {
      const withoutMatch = prev.filter((entry) => !(
        entry.sessionId === threadRef
        && entry.atomRef === intent.targetAtomRef
        && entry.symbol === symbol
        && entry.intentKind === intentKind
      ));
      // 'removed' un-does a just-authored 'added'; 'added' places (deduped above).
      return reactionKind === 'removed' ? withoutMatch : [...withoutMatch, optimistic];
    });
    setActionError(null);
    // The intent's writer comes with the send road (../do-work/chat-send-work); a road that could not load is a save
    // that failed, said as one.
    const work = loadChatSendWork();
    void work.then(({ submitMessageIntentFromChat }) => submitMessageIntentFromChat({
      targetAtomRef: intent.targetAtomRef,
      targetThreadRef: threadRef,
      symbol,
      intentKind,
      reactionKind,
      intentId: retry.intentId,
      now: retry.at,
      reactCapability: retry.capability,
    })).then((record) => {
      if (intentRetriesRef.current.get(retryKey) === retry) intentRetriesRef.current.delete(retryKey);
      return record;
    }).catch(async (error) => {
      const viewerIntentFailure = await work.then(module => module.viewerIntentFailure, () => (_: unknown) => ({ saved: false, uncertain: false, message: 'Your annotation could not be saved. Try again.' }));
      const failure = viewerIntentFailure(error);
      // Fail closed and visible: drop the optimistic annotation so the transcript
      // never shows a reaction the log did not accept.
      if (!failure.saved && !failure.uncertain) setOptimisticReactions((prev) => prev.filter((entry) => !(
        entry.sessionId === threadRef
        && entry.atomRef === intent.targetAtomRef
        && entry.symbol === symbol
        && entry.intentKind === intentKind
      )));
      console.error('[chat] save reaction failed:', error);
      setActionError(failure.message);
    });
  }, [activeSession, onRecordAction, recordActions]);

  const handleMessagePerform = useCallback<MessagePerformHandler>((message, control) => (
    executeMessagePerformControl({
      message,
      control,
      workflowActions,
      callerAuthorityRef: chatConfig.accountId || chatConfig.participantRef,
      partitionKey: 'runtime-partition',
    })
  ), [chatConfig.accountId, chatConfig.participantRef, workflowActions]);

  const planSteps = useMemo(
    () => parsePlanSteps(messages),
    [messages],
  );
  const planModeDetected = useMemo(
    () => detectPlanMode(messages),
    [messages],
  );
  const exitPlanPayload = useMemo(
    () => extractExitPlanPayload(messages),
    [messages],
  );
  // Steps are read out of the words themselves, so an ordinary reply that
  // happens to be structured opens a panel across the reply showing the same
  // sentences again. Where a surface says it does not lift steps out, the reply
  // is left whole.
  const liftsStepsOutOfReplies = surfaceInput?.lifts_steps_out_of_replies !== false;
  const hasPlanSidebar = liftsStepsOutOfReplies
    && (planModeDetected || planSteps.length > 0 || !!exitPlanPayload.planContent);
  const planSignature = useMemo(
    () => JSON.stringify({
      planContent: exitPlanPayload.planContent,
      planPreamble: exitPlanPayload.planPreamble,
      planModeDetected,
      steps: planSteps.map((step) => [step.id, step.status, step.title]),
    }),
    [exitPlanPayload.planContent, exitPlanPayload.planPreamble, planModeDetected, planSteps],
  );

  const teammates = useMemo(
    () => collectChatTeammates(messages),
    [messages],
  );

  useEffect(() => {
    if (!activeSession?.filePath || !activeSessionId) {
      setTranscriptPage(null);
      setTranscriptPageLoading(false);
      setTranscriptPageError(null);
      return;
    }

    const controller = new AbortController();
    setTranscriptPage(null);
    setTranscriptPageLoading(true);
    setTranscriptPageError(null);

    readLatestSourceTranscriptPage(activeSession.filePath, {
      sessionId: activeDecoderSessionId,
      signal: controller.signal,
    })
      .then((page) => {
        if (controller.signal.aborted) return;
        setTranscriptPage(page);
        setTranscriptPageError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTranscriptPage(null);
        // Only positive publication acknowledgement can defer to the subscription.
        // A refused or failed read must never look like an empty conversation.
        if (!(error instanceof TranscriptPagePublishedError)) {
          console.error('[chat] read transcript failed:', error);
          setTranscriptPageError('This conversation could not be loaded. Try opening it again.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setTranscriptPageLoading(false);
      });

    return () => controller.abort();
    // IDENTITY ONLY — never key this fetch on an activity signal.
    // This effect exists to fetch the page for the *selected thread*; its cleanup
    // aborts the in-flight inline `execute_definition`, and an abort skips the
    // `.finally()` that clears `transcriptPageLoading` AND cancels the workflow
    // before its `publish` step writes the per-session window. If we depend on
    // `activeSession?.lastActivityAt`, then continuous activity on the open thread
    // (the live-update tick, or the user actively receiving messages) re-runs this
    // effect on every bump, aborting the read before it can settle — the thread
    // "loads forever" and its transcript never publishes. Live updates to the OPEN
    // thread flow reactively through the `selected-chat-message-window:<id>:latest`
    // read-scope, NOT by re-running this fetch.
  }, [
    activeSession?.filePath,
    activeSessionId,
    activeDecoderSessionId,
  ]);

  const handleShowLatestTranscriptPage = useCallback(async () => {
    if (!activeSession?.filePath || !activeSessionId || transcriptPageLoading) return;
    const selected = activeDecoderSessionId;
    setTranscriptPageLoading(true);
    setTranscriptPageError(null);
    try {
      const page = await readChatTranscriptPage({ sessionId: selected, filePath: activeSession.filePath,
        startIndex: -1, limit: SELECTED_TRANSCRIPT_PAGE_LIMIT,
        ...(typeof surfaceInput?.transcriptSessionId === 'string' ? { showLatest: true } : {}) });
      if (currentTranscriptSession.current === selected) {
        // A workspace window keeps publishing live changes. Do not cover that subscription with an inline snapshot.
        setTranscriptPage(typeof surfaceInput?.transcriptSessionId === 'string' ? null : page);
        resetChatPanelScrollState(selected ?? activeSessionId);
        setTranscriptVisit(visit => visit + 1);
      }
    } catch (error) {
      if (currentTranscriptSession.current === selected && !(error instanceof TranscriptPagePublishedError)) {
        setTranscriptPageError('The latest messages could not load. Try again.');
      }
    } finally {
      if (currentTranscriptSession.current === selected) setTranscriptPageLoading(false);
    }
  }, [activeSession?.filePath, activeSessionId, activeDecoderSessionId, transcriptPageLoading, surfaceInput?.transcriptSessionId]);

  const handleLoadOlderTranscriptPage = useCallback(async () => {
    if (!activeSession?.filePath || !activeSessionId || !selectedTranscriptPage || transcriptPageLoading || !selectedTranscriptPage.has_older) return;

    const olderCursor = selectedTranscriptPage.older_cursor ?? null;
    const olderStartIndex = selectedTranscriptPage.start_index === null
      ? null
      : Math.max(0, selectedTranscriptPage.start_index - SELECTED_TRANSCRIPT_PAGE_LIMIT);
    if (olderCursor === null && olderStartIndex === null) return;

    const selected = activeDecoderSessionId;
    setTranscriptPageLoading(true);
    setTranscriptPageError(null);
    try {
      const olderPage = await readChatTranscriptPage({
        sessionId: activeDecoderSessionId,
        filePath: activeSession.filePath,
        startIndex: olderStartIndex ?? -1,
        limit: SELECTED_TRANSCRIPT_PAGE_LIMIT,
        beforeByteOffset: olderCursor,
      });
      if (currentTranscriptSession.current !== selected) return;
      setTranscriptPage((current) => {
        const basePage = current ?? selectedWindowForActiveSession;
        if (!basePage || basePage.file_path !== olderPage.file_path) return olderPage;
        const lines = [...olderPage.lines, ...basePage.lines];
        const complete = !olderPage.has_older && !basePage.has_newer;
        return {
          ...olderPage,
          limit: lines.length,
          total_count: basePage.has_newer ? null : complete ? lines.length : basePage.total_count_known ? basePage.total_count : olderPage.total_count,
          total_count_known: !basePage.has_newer && (complete || basePage.total_count_known || olderPage.total_count_known),
          has_newer: basePage.has_newer,
          lines,
        };
      });
    } catch (error) {
      if (currentTranscriptSession.current === selected) {
        console.error('[chat] read earlier transcript failed:', error);
        setTranscriptPageError('Failed to load earlier messages.');
      }
    } finally {
      if (currentTranscriptSession.current === selected) setTranscriptPageLoading(false);
    }
  }, [
    activeSession?.filePath,
    activeSessionId,
    activeDecoderSessionId,
    selectedTranscriptPage,
    selectedWindowForActiveSession,
    transcriptPageLoading,
  ]);

  useEffect(() => {
    if (!hasPlanSidebar) return;
    setIsPlanSidebarOpen(true);
  }, [hasPlanSidebar, planSignature]);

  useEffect(() => {
    if (!pendingConversation || pendingConversation.recordId || activeSessionId) return;
    if (pendingConversation.ledgerConversationId) return;

    const candidate = sessions.find((session) => {
      const sessionParticipantRefs = session.participantRefs.length > 0 ? session.participantRefs : [session.participantRef];
      const pendingParticipantRefs = pendingConversation.participantRefs.length > 0
        ? pendingConversation.participantRefs
        : [pendingConversation.participantRef];
      if (!pendingParticipantRefs.some((participantRef) => sessionParticipantRefs.includes(participantRef))) return false;
      if (pendingConversation.accountDir && session.accountDir !== pendingConversation.accountDir) return false;
      if (pendingConversation.projectSlug && session.projectSlug !== pendingConversation.projectSlug) return false;
      if (pendingConversation.sourceSessionRef) return session.sessionId === pendingConversation.sourceSessionRef;

      const startedAt = Date.parse(pendingConversation.startedAt);
      const lastActivityAt = Date.parse(session.lastActivityAt);
      return Number.isFinite(startedAt)
        && Number.isFinite(lastActivityAt)
        && lastActivityAt >= startedAt - 60_000;
    });

    if (!candidate) return;
    setTabSession(candidate.recordId);
    setPendingConversation(null);
    setActionError(null);
  }, [activeSessionId, pendingConversation, sessions, setTabSession]);

  useEffect(() => {
    if (!pendingConversation || !activeSessionId) return;
    if (pendingConversation.recordId !== activeSessionId) return;

    const currentCount = selectedTranscriptMessageCount;
    if (!pendingConversationAbsorbed && currentCount <= pendingConversation.baselineMessageCount) return;

    setPendingConversation(null);
    setActionError(null);
  }, [
    activeSessionId,
    pendingConversation,
    pendingConversationAbsorbed,
    selectedTranscriptMessageCount,
  ]);

  const handlePresetSelect = useCallback((label: string, prompt: string, description?: string) => {
    setActivePreset({ label, prompt, description });
  }, []);

  const handlePresetDismiss = useCallback(() => {
    setActivePreset(null);
  }, []);

  const handleSelectHistorySession = useCallback((recordId: string) => {
    retrySendAttemptRef.current = null;
    setRetrySendContent(null);
    resetChatPanelScrollState(recordId);
    setPendingConversation(null);
    setProducerTurn((current) => { if (current?.capabilityAuthorization) expireRoundAuthorization(current.capabilityAuthorization); return null; });
    setLiveTurn(null);
    liveTurnRef.current = null;
    setIsProcessing(false);
    setActionError(null);
    setTabSession(recordId);
  }, [setTabSession]);

  const handleNewChat = useCallback(() => {
    retrySendAttemptRef.current = null;
    setRetrySendContent(null);
    setPendingConversation(null);
    setProducerTurn((current) => { if (current?.capabilityAuthorization) expireRoundAuthorization(current.capabilityAuthorization); return null; });
    setLiveTurn(null);
    liveTurnRef.current = null;
    setIsProcessing(false);
    setActionError(null);
    setTabSession(null);
    if (defaultParticipantRef) setChatConfig(normalizeChatSessionConfig({ participantRefs: [], accountId: '', model: null }));
  }, [setTabSession, defaultParticipantRef]);

  const handleSend = useCallback(async (content: string): Promise<boolean> => {
    const sendStartedAtMs = monotonicNowMs();
    const trimmed = content.trim();
    if (!trimmed || isProcessing) return false;
    retrySendAttemptRef.current = null;
    setRetrySendContent(null);

    if (inputMode === 'idea') {
      if (!currentProjectFeed.activeProject) {
        setActionError('No project selected');
        return false;
      }
      setActionError(null);
      void createIdeaFromChat({
        content: trimmed,
        project: currentProjectFeed.activeProject,
      }).catch((error) => {
        console.error('[chat] create idea failed:', error);
        setActionError('Failed to create idea.');
      });
      return true;
    }

    // Channel send (iMessage etc.): a thread is sendable ONLY when its source
    // declared a send capability AND the decoder resolved a single recipient
    // handle. Both are opaque data carried up from the decoder/mapper; we forward
    // them to the egress front door and never parse a channel, phone number, or
    // transport. Absent either -> fall through to the normal AI-turn path. This is
    // the whole "reply into a real conversation" branch: no producer, no polling.
    if (activeSession?.sendCapability && activeSession.sendRef) {
      const capability = activeSession.sendCapability;
      const recipient = activeSession.sendRef;
      const replyToThreadRef = activeSession.recordId;
      setActionError(null);
      const echo: AgentMessage = {
        id: `outbound:${Date.now()}`,
        type: 'text',
        content: trimmed,
        role: 'human',
        timestamp: new Date().toISOString(),
        // Optimistic, unconfirmed: provenance 0 renders faint "Pending". The host
        // NEVER upgrades this — only an AUTHORITATIVE (provenance 10) native echo
        // from the decoder shows Sent/Delivered/Read (SP5 fail-closed egress).
        stateEvents: [{ key: 'pending', provenance: 0, at: new Date().toISOString() }],
      };
      setOutboundEchoes((prev) => [...prev, { sessionId: replyToThreadRef, message: echo }]);
      void submitMessageEgressFromChat({
        capability,
        recipient,
        body: trimmed,
        replyToThreadRef,
      }).catch((error) => {
        // Fail closed and visible: drop the optimistic bubble so the transcript
        // never shows a message the engine did not accept for delivery.
        setOutboundEchoes((prev) => prev.filter((entry) => entry.message.id !== echo.id));
        console.error('[chat] send message failed:', error);
        setRetrySendContent(trimmed);
        setActionError('Your message could not be sent. Try again.');
      });
      return true;
    }

    const sessionMeta = activeSession;
    const canonicalResumeConversationId = sessionMeta?.recordId.startsWith('addressed-exchange:')
      ? sessionMeta.recordId
      : null;
    const existingLedgerConversationId = !sessionMeta ? pendingConversation?.ledgerConversationId ?? null : null;
    const participantRefsForTurn = sessionMeta
      ? (sessionMeta.participantRefs.length > 0 ? sessionMeta.participantRefs : [sessionMeta.participantRef].filter(Boolean))
      : chatConfig.participantRefs.length > 0
        ? chatConfig.participantRefs
        : [chatConfig.participantRef].filter(Boolean);
    const participantRef = participantRefsForTurn[0] ?? '';
    const exchangeScopeRefForContext = existingLedgerConversationId ?? sessionMeta?.recordId ?? null;
    const visibleContextGrants = contextGrants.filter((grant) => grantVisibleToTurn(
      grant,
      exchangeScopeRefForContext,
      new Set(participantRefsForTurn),
    ));
    const sendWorkLoading = loadChatSendWork();
    sendWorkLoading.catch(() => {});
    const exchange = await materializeAddressedExchange({
      userText: trimmed,
      presetPrompt: activePreset?.prompt ?? null,
      selection,
      visibleMessages: canonicalResumeConversationId
        ? canonicalConversations.messagesBySession[canonicalResumeConversationId] ?? []
        : pendingConversation?.messages ?? [],
      includeVisibleHistory: Boolean(
        (existingLedgerConversationId || canonicalResumeConversationId)
        && (canonicalResumeConversationId
          ? (canonicalConversations.messagesBySession[canonicalResumeConversationId] ?? []).length > 0
          : pendingConversation?.messages.length),
      ),
      contextGrants: visibleContextGrants,
      promptAssembly: livePromptAssembly,
    });
    const executionPrompt = exchange.prompt;
    const {
      readAddressedMessageDispatch, dispatchAddressedMessage, readAnswerFromRoute,
      canonicalChatMessagesToAddressedExchangeTurnDrafts, mergeAddressedExchangeTurnDrafts, writeAddressedExchangeThroughConversations,
      chatTurnSubmissionForRequest, submitChatTurnViaProducer,
    } = await sendWorkLoading;

    for (const routeParticipantRef of participantRefsForTurn) {
      const routeParticipantInfo = participantInfoByRef.get(routeParticipantRef);
      const routeAdapter = routeParticipantInfo?.adapter ?? null;
      const hasExecutableRoute = isProcessAddressedWayToReachAdapter(routeAdapter)
        || isAiRecordsProducerAddressedWayToReachAdapter(routeAdapter)
        || Boolean(readAddressedMessageDispatch(routeAdapter));
      const sendReadinessError = getParticipantSendReadinessError({
        participantRef: routeParticipantRef,
        participantRegistryCount: availableParticipants.length,
        reachableParticipantCount: availableParticipants.filter((participant) => (
          participant.adapter?.ownerTargetRef || participantHasRouteTarget(participant)
        )).length,
        hasOwnerTargetRef: hasExecutableRoute,
        hasRouteTargetRef: hasExecutableRoute,
      });
      if (sendReadinessError) {
        logLiveTurnDiagnostic('missing-launch-descriptor', {
          elapsedMs: elapsedMsSince(sendStartedAtMs),
          requestedParticipantRef: routeParticipantRef || null,
          participantRegistryCount: availableParticipants.length,
          publishedParticipantRefs: availableParticipants.map((participant) => participant.participantRef),
          selectedSessionRecordId: sessionMeta?.recordId ?? null,
        });
        setRetrySendContent(trimmed);
        setActionError('This participant is not available right now. Choose another participant or try again.');
        return false;
      }
    }

    const participantInfo = participantInfoByRef.get(participantRef);
    const adapter = participantInfo?.adapter ?? null;
    if (!adapter) {
      setRetrySendContent(trimmed);
      setActionError('This participant is not available right now. Choose another participant or try again.');
      return false;
    }
    if (participantInfo?.metadata?.participantKind === 'agent-profile'
      && !canRouteSelectedModel(chatConfig.model,
        (participantInfo.metadata.configuredModelRefs as string[]) ?? [], modelDescriptors)) {
      void refreshChatModelInventory().catch(() => {});
      setActionError('The selected model is unavailable. Choose an available assistant before sending.');
      return false;
    }
    const account = findAddressedParticipantAccount(
      participantInfo,
      sessionMeta ? null : chatConfig.accountId || null,
      sessionMeta?.accountDir ?? null,
    );
    const accountDir = sessionMeta?.accountDir ?? (account ? basename(account.configDir) : null);

    const projectSlug = sessionMeta?.projectSlug
      || currentProjectFeed.activeProject
      || (activeSessionProjectPath ? basename(activeSessionProjectPath) : null);
    // Chat submits every CLI-shaped reply through ai-records-producer. That
    // generic owner resolves a launch descriptor's cwd:"projectPath" token to
    // the portable process root `.` when no materialized project tree exists.
    // Do not add a frontend-only hard gate: a fresh app legitimately has no
    // projects/current-project DATA, and the owner can still execute safely.

    const startedAt = new Date().toISOString();
    logLiveTurnDiagnostic('send-start', {
      elapsedMs: elapsedMsSince(sendStartedAtMs),
      participantRef,
      resume: Boolean(sessionMeta),
      hasSourceSessionRef: Boolean(sessionMeta?.sessionId),
      hasModel: Boolean(chatConfig.model),
      participantRegistryCount: availableParticipants.length,
      launchArgvCount: isProcessAddressedWayToReachAdapter(adapter)
        ? (Boolean(sessionMeta) && adapter.launch.resumeArgv ? adapter.launch.resumeArgv : adapter.launch.argv).length
        : null,
      projectSlug,
      executionRoot: '.',
    });
    const ledgerConversationId = canonicalResumeConversationId
      ?? (!sessionMeta ? existingLedgerConversationId ?? createChatAddressedExchangeConversationId() : null);
    const userTurnId = ledgerConversationId ? createChatAddressedExchangeTurnId() : null;
    const userVisibleContent = ledgerConversationId ? trimmed : executionPrompt;
    const optimisticMessage: ChatCanonicalAgentMessage = {
      id: userTurnId ?? `pending:${Date.now()}`,
      type: 'text',
      content: userVisibleContent,
      role: 'human',
      authorRef: 'addressed-participant:user',
      speakerRef: 'addressed-participant:user',
      timestamp: startedAt,
    };
    const sourceSessionRef = isProcessAddressedWayToReachAdapter(adapter)
      ? resolveInitialConversationSourceSessionRef({
          launch: adapter.launch,
          shouldResumeSourceSession: exchange.resumeSourceSession && Boolean(sessionMeta),
          selectedSessionId: ledgerConversationId ? null : sessionMeta?.sessionId ?? null,
        })
      : ledgerConversationId ? null : sessionMeta?.sessionId ?? null;
    const existingLedgerMessages = canonicalResumeConversationId
      ? canonicalConversations.messagesBySession[canonicalResumeConversationId] ?? []
      : ledgerConversationId && pendingConversation?.ledgerConversationId === ledgerConversationId
        ? pendingConversation.messages
        : [];
    const lastExistingLedgerMessage = existingLedgerMessages.length > 0
      ? existingLedgerMessages[existingLedgerMessages.length - 1]
      : null;
    const lastExistingSequence = typeof (lastExistingLedgerMessage as { sequence?: unknown } | null)?.sequence === 'number'
      ? (lastExistingLedgerMessage as { sequence: number }).sequence
      : null;
    const userTurnSequence = lastExistingLedgerMessage
      ? lastExistingSequence !== null ? lastExistingSequence + 1 : existingLedgerMessages.length
      : 0;
    const userParentTurnId = lastExistingLedgerMessage?.id ?? null;
    const existingCanonicalTurnDrafts = ledgerConversationId
      ? canonicalChatMessagesToAddressedExchangeTurnDrafts(
        existingLedgerMessages,
        ledgerConversationId,
        participantRef,
      )
      : [];
    const conversationParticipantRefs = Array.from(new Set([
      ...participantRefsForTurn,
      ...existingCanonicalTurnDrafts.flatMap((turn) => [turn.authorRef, turn.speakerRef].filter((ref): ref is string => Boolean(ref))),
      'addressed-participant:user',
    ]));
    const conversationWayRefs = Array.from(new Set([
      participantInfo?.wayToReachRef ?? 'way:chat:current-surface',
    ]));
    const conversationServiceConnectionRefs = adapter.serviceConnectionRefs;
    const newUserTurnDraft: ChatAddressedExchangeTurnDraft | null = ledgerConversationId && userTurnId ? {
      turnId: userTurnId,
      conversationId: ledgerConversationId,
      parentTurnId: userParentTurnId ?? undefined,
      sequence: userTurnSequence,
      role: 'human',
      content: userVisibleContent,
      createdAt: startedAt,
      speakerRef: 'addressed-participant:user',
      authorRef: 'addressed-participant:user',
      sourceRefs: [sourceSessionRef, sessionMeta?.filePath].filter((ref): ref is string => Boolean(ref)),
      correlationRefs: [userTurnId, ledgerConversationId],
    } : null;
    if (newUserTurnDraft) {
      optimisticMessage.sequence = newUserTurnDraft.sequence;
      optimisticMessage.parentTurnRef = newUserTurnDraft.parentTurnId;
      optimisticMessage.sourceRefs = newUserTurnDraft.sourceRefs;
      optimisticMessage.correlationRefs = newUserTurnDraft.correlationRefs;
    }
    const completeUserTurnDrafts = ledgerConversationId && newUserTurnDraft
      ? mergeAddressedExchangeTurnDrafts(
        [...existingCanonicalTurnDrafts, newUserTurnDraft],
        ledgerConversationId,
      )
      : [];

    const pendingState: PendingConversation = {
      recordId: sessionMeta?.recordId ?? null,
      ledgerConversationId,
      sourceSessionRef,
      participantRef,
      participantRefs: participantRefsForTurn,
      accountDir,
      projectSlug,
      projectLabel: sessionMeta?.projectName ?? projectSlug,
      sourcePath: sessionMeta?.filePath ?? null,
      startedAt,
      baselineMessageCount: selectedTranscriptMessageCount || canonicalMessages.length,
      messages: [...existingLedgerMessages, optimisticMessage],
      routeResultsByParticipantRef: {},
    };

    setActivePreset(null);
    setActionError(null);
    setPendingConversation(pendingState);
    setProducerTurn((current) => { if (current?.capabilityAuthorization) expireRoundAuthorization(current.capabilityAuthorization); return null; });
    setLiveTurn(null);
    liveTurnRef.current = null;
    finalizingLiveTurnRef.current = null;
    setIsProcessing(true);
    logLiveTurnDiagnostic('send-accepted', {
      elapsedMs: elapsedMsSince(sendStartedAtMs),
      participantRef,
      ledgerConversationId,
      sourceSessionRef,
      pendingMessageCount: pendingState.messages.length,
    });

    const ledgerConversationTitle = ledgerConversationId ? titleFromPrompt(trimmed) : null;
    const ledgerConversationCreatedAt = pendingConversation?.startedAt ?? startedAt;
    const requestId = `chat-${userTurnId ?? createChatAddressedExchangeTurnId()}`;
    let attemptRunning = false;
    let conversationSaved = false;
    let producerDispatched = false;

    const sendAttempt = async () => {
      if (attemptRunning) return;
      attemptRunning = true;
      setIsProcessing(true);
      setActionError(null);
      try {
        if (participantInfo?.metadata?.participantKind === 'agent-profile') {
          const configuredRefs = (participantInfo.metadata.configuredModelRefs as string[]) ?? [];
          if (!canRouteSelectedModel(chatConfig.model, configuredRefs, modelDescriptorsRef.current)) {
            try { await refreshChatModelInventory(); } catch { /* The current owner facts remain authoritative. */ }
          }
          if (!canRouteSelectedModel(chatConfig.model, configuredRefs, modelDescriptorsRef.current)) {
            setActionError('The selected model is unavailable. Choose an available assistant before sending.');
            setRetrySendContent(null);
            setIsProcessing(false);
            return;
          }
        }
        if (!conversationSaved && ledgerConversationId && userTurnId) {
          await writeAddressedExchangeThroughConversations({
            conversation: {
              conversationId: ledgerConversationId,
              participantRefs: conversationParticipantRefs,
              wayRefs: conversationWayRefs,
              serviceConnectionRefs: conversationServiceConnectionRefs,
              title: ledgerConversationTitle ?? ledgerConversationId,
              lastMessagePreview: userVisibleContent,
              lastActivityAt: startedAt,
              createdAt: ledgerConversationCreatedAt,
              updatedAt: startedAt,
              messagePageRef: `message-page:${ledgerConversationId}`,
              cursorRef: userTurnId,
              projectSlug: sessionMeta?.projectSlug ?? projectSlug ?? undefined,
              projectName: sessionMeta?.projectName ?? projectSlug ?? undefined,
            },
            turns: completeUserTurnDrafts,
            messagePageRef: `message-page:${ledgerConversationId}`,
            nextCursorRef: userTurnId,
          });
          conversationSaved = true;
        }

        const addressedRoutes = participantRefsForTurn.map((routeParticipantRef) => {
          const routeAdapter = participantInfoByRef.get(routeParticipantRef)?.adapter ?? null;
          return {
            participantRef: routeParticipantRef,
            adapter: routeAdapter,
            dispatch: isProcessAddressedWayToReachAdapter(routeAdapter)
              || isAiRecordsProducerAddressedWayToReachAdapter(routeAdapter)
              ? null
              : readAddressedMessageDispatch(routeAdapter),
          };
        });
        const allUseAddressedDispatch = addressedRoutes.length > 0
          && addressedRoutes.every((route) => route.dispatch);

        if (allUseAddressedDispatch) {
          const routeReplies = await Promise.all(addressedRoutes.map((route, index) => dispatchAddressedMessage(
            route.adapter,
            {
              messageRef: `${userTurnId ?? `message:${Date.now()}`}:${index}`,
              participantRef: route.participantRef,
              senderRef: 'addressed-participant:user',
              body: trimmed,
              sentAt: startedAt,
              conversationRef: ledgerConversationId,
              sequence: userTurnSequence,
            },
          )));
          // A route that answered immediately has its words already; showing
          // them now is the difference between a reply that arrives and one the
          // person only finds by reopening the conversation later.
          const answers = routeReplies
            .map((reply) => readAnswerFromRoute(reply))
            .filter((answer): answer is string => Boolean(answer));
          if (answers.length > 0) {
            const answeredAt = new Date().toISOString();
            setPendingConversation((current) => current ? {
              ...current,
              messages: [
                ...current.messages,
                ...answers.map((content, index) => ({
                  id: `${userTurnId ?? `message:${Date.now()}`}:answer:${index}`,
                  type: 'text' as const,
                  content,
                  role: 'assistant' as const,
                  timestamp: answeredAt,
                })),
              ],
            } : current);
          }
          setIsProcessing(false);
          void refreshChatHistory().catch((scanError) => {
            setActionError(errorWords(scanError, 'Failed to refresh chat history'));
          });
          return;
        }

        const allUseReplyTransport = addressedRoutes.length > 0
          && addressedRoutes.every((route) => (
            isProcessAddressedWayToReachAdapter(route.adapter)
            || isAiRecordsProducerAddressedWayToReachAdapter(route.adapter)
          ));
        if (!allUseReplyTransport) {
          throw new Error('These participants cannot reply in the same conversation yet.');
        }

        // Fire the turn through the generic ai-records-producer
        const submission = chatTurnSubmissionForRequest(requestId);

        setProducerTurn({
          requestId,
          submission,
          userVisibleContent,
          selectedSessionId: pendingState.recordId,
          ledgerConversationId,
          userTurnId,
          userParentTurnId,
          userTurnSequence,
          ledgerConversationTitle,
          ledgerConversationCreatedAt,
          ledgerParticipantRefs: conversationParticipantRefs,
          ledgerWayRefs: conversationWayRefs,
          ledgerServiceConnectionRefs: conversationServiceConnectionRefs,
          ledgerProjectSlug: projectSlug,
          ledgerProjectLabel: sessionMeta?.projectName ?? projectSlug,
          canonicalTurnDrafts: completeUserTurnDrafts,
          ledgerAccountDir: accountDir,
          sourcePath: pendingState.sourcePath,
          startedAt,
          startedAtMs: sendStartedAtMs,
          state: 'pending',
          errorMessage: null,
          assistantReplyText: null,
          userText: userVisibleContent,
          agentRef: participantRef || null,
          modelId: chatConfig.model ?? null,
          toolRound: 0,
          toolActivity: [],
          capabilityAuthorization: null,
          discoveredCapabilities: [],
          // From live session/config state, never model text. Empty fails closed.
          callerAuthorityRef: chatConfig.accountId || participantRef || '',
        });
        retrySendAttemptRef.current = null;
        setRetrySendContent(null);
        // Subscribe to this exact request before dispatch. A rejected bridge
        // acknowledgement does not prove that provider work never started.
        producerDispatched = true;
        await submitChatTurnViaProducer({
          requestId, instructionText: executionPrompt,
          modelId: chatConfig.model ?? undefined, agentRef: participantRef || undefined,
        });
      } catch (error) {
        console.error('[chat] submit message failed:', error);
        setRetrySendContent(producerDispatched ? null : trimmed);
        setActionError(producerDispatched
          ? 'Your message was saved, but the reply has not been confirmed yet.'
          : 'Your message could not be sent. Try again.');
        setIsProcessing(false);
      } finally {
        attemptRunning = false;
      }
    };
    retrySendAttemptRef.current = sendAttempt;
    void sendAttempt();
    return true;
  }, [
    activePreset,
    activeSession,
    activeSessionProjectPath,
    availableParticipants,
    canonicalMessages,
    chatConfig.accountId,
    chatConfig.participantRef,
    chatConfig.participantRefs,
    chatConfig.model,
    contextGrants,
    participantInfoByRef,
    selectedTranscriptMessageCount,
    availableParticipants.length,
    inputMode,
    isProcessing,
    pendingConversation,
    placeableSurfaces,
    selection,
    currentProjectFeed.activeProject,
    workflowActions,
    activeSessionId,
  ]);

  const handleRetrySend = useCallback(() => {
    if (!retrySendContent || isProcessing) return;
    setActionError(null);
    if (retrySendAttemptRef.current) void retrySendAttemptRef.current();
    else void handleSend(retrySendContent);
  }, [handleSend, isProcessing, retrySendContent]);

  // React to producer owner records and materialize results. The runtime input
  // subscription pushes current result/error records; Chat owns no clock or poll.
  useEffect(() => {
    if (!producerTurn) return;
    if (producerTurn.state !== 'pending') return;

    let cancelled = false;
    const roundAbort = new AbortController();
    const handleStatus = async () => {
      try {
        const {
          advanceChatToolRoundWithPolicy, discoverCapabilitiesForChatWithBinding, submitChatTurnViaProducer,
          mergeAddressedExchangeTurnDrafts, writeAddressedExchangeThroughConversations,
        } = await loadChatSendWork();
        const status = producerStatus;

        if (cancelled) return;

        if (status.state === 'done' && 'items' in status && status.items) {
          // Multi-item result (message is first item)
          const messageItem = status.items[0];
          const replyText = typeof messageItem?.text === 'string' ? messageItem.text : '';

          if (!replyText.trim()) {
            const emptyReplyMessage = 'No reply was returned. Try again.';
            setProducerTurn((current) => current ? {
              ...current,
              state: 'error',
              errorMessage: emptyReplyMessage,
            } : current);
            setActionError(emptyReplyMessage);
            setIsProcessing(false);
            return;
          }

          if (!cancelled) {
            // --- Agentic ReAct tool round (delegated; ChatView holds NO loop) ---
            // advanceChatToolRound (chat do-work) parses any tool fences, dispatches them
            // via chat transport, frames the results with the owning decision primitives
            // (ai-records-producer + ai-tool-catalog), and returns CONTINUE (re-prompt) or
            // FINAL. This view only
            // maps the step onto its turn state. The no-fence path below is UNCHANGED.
            try {
              const step = await advanceChatToolRoundWithPolicy({
                replyText,
                requestId: producerTurn.requestId,
                userText: producerTurn.userText,
                toolRound: producerTurn.toolRound,
                workflowActions,
                toolResultAddressPrefix: `package::chat::tool-result::${producerTurn.requestId}`,
                agentRef: producerTurn.agentRef,
                resultPolicy: liveResultPolicy,
                runTools: (assistantText, enrich) =>
                  executeChatWorkRequests({
                    assistantText, workflowActions, authorization: producerTurn.capabilityAuthorization ?? undefined,
                    turnId: producerTurn.requestId, round: producerTurn.toolRound,
                    callerAuthorityRef: producerTurn.callerAuthorityRef, enrichInput: enrich,
                    // The active producer submission owns this turn's partition;
                    // do not substitute a package-wide literal for a caller-owned
                    // receipt. The identical partition reaches the ambiguity
                    // readback below.
                    partitionKey: producerTurn.submission.resultPartitionLabel,
                    readReceipt: (address) =>
                      readChatToolResultRecord(producerTurn.submission.resultPartitionLabel, address).catch(() => null),
                    observe: (event) => {
                      logLiveTurnDiagnostic(String(event.event), event);
                      void recordCapabilityObservation({ turnId: producerTurn.requestId, round: producerTurn.toolRound, event }).catch((error) => logLiveTurnDiagnostic('capability-observation-failed', { error: String(error) }));
                    },
                    signal: roundAbort.signal,
                    onLifecycle: setInFlightCapability,
                  }),
                runDiscovery: (query, signal) => discoverCapabilitiesForChatWithBinding(query, signal),
                discoverySignal: roundAbort.signal,
                observe: (event) => {
                  logLiveTurnDiagnostic(String(event.event), event);
                  void recordCapabilityObservation({ turnId: producerTurn.requestId, round: producerTurn.toolRound, event }).catch((error) => logLiveTurnDiagnostic('capability-observation-failed', { error: String(error) }));
                },
                readToolResult: (address) =>
                  readChatToolResultRecord(producerTurn.submission.resultPartitionLabel, address).catch(() => null),
                emitToolMessage: (toolMessage) => {
                  if (cancelled) return;
                  // Upsert by id so the SAME tool call renders as ONE rich
                  // ToolUseBlock (AgentActivityRenderer): first emit = in-progress
                  // (spinner), second emit (same id) fills the result. Mirrors the
                  // imported-transcript decoder — identical UI for live + imported.
                  setPendingConversation((current) => {
                    if (!current) return current;
                    const built = {
                      id: toolMessage.id,
                      type: toolMessage.type,
                      toolUse: toolMessage.toolUse,
                      content: '',
                      role: 'assistant' as const,
                      timestamp: new Date().toISOString(),
                    };
                    const idx = current.messages.findIndex((m) => m.id === toolMessage.id);
                    if (idx >= 0) {
                      const next = current.messages.slice();
                      next[idx] = { ...next[idx], ...built };
                      return { ...current, messages: next };
                    }
                    return { ...current, messages: [...current.messages, built] };
                  });
                },
                isCancelled: () => cancelled,
              }, liveTransitionPolicy);
              if (step.kind === 'continue') {
                const submission = await submitChatTurnViaProducer({
                  requestId: step.nextRequestId,
                  instructionText: step.continuation,
                  modelId: producerTurn.modelId ?? undefined,
                  agentRef: producerTurn.agentRef ?? undefined,
                });
                if (!cancelled) {
                  setProducerTurn((current) => current ? {
                    ...current,
                    requestId: step.nextRequestId,
                    submission,
                    state: 'pending',
                    assistantReplyText: null,
                    toolRound: current.toolRound + 1,
                    startedAtMs: monotonicNowMs(),
                    ...(() => { const next = liveTransitionPolicy ? advanceCapabilityRound({ requestId: current.requestId, round: current.toolRound, callerAuthorityRef: current.callerAuthorityRef, authorization: current.capabilityAuthorization, discovered: current.discoveredCapabilities }, step, Date.now(), liveTransitionPolicy.authorizationTtlMs) : null; return { capabilityAuthorization: next?.authorization ?? null, discoveredCapabilities: next?.discovered ?? [] }; })(),
                  } : current);
                }
                return; // keep polling the continuation turn; do NOT finalize yet
              }
            } catch (loopError) {
              console.error('chat tool round failed:', loopError);
              // Fall through to finalize with whatever the model said.
            }
            // Strip any residual tool fence so the user never sees raw JSON blocks.
            if (producerTurn.capabilityAuthorization) expireRoundAuthorization(producerTurn.capabilityAuthorization);
            const displayText = replyText.replace(/```bitfield-(?:work-request|capability-discovery)[\s\S]*?```/g, '').trim() || replyText;

            setProducerTurn((current) => current ? { ...current, state: 'done', assistantReplyText: replyText } : current);

            // Add the assistant message to the conversation
            const assistantTurnRef = `${producerTurn.userTurnId}:reply`;
            const completedAt = new Date().toISOString();
            const assistantMessage: ChatCanonicalAgentMessage = {
              id: assistantTurnRef,
              type: 'text',
              content: displayText,
              role: 'assistant',
              authorRef: producerTurn.agentRef || 'ai-records-producer',
              speakerRef: producerTurn.agentRef || 'ai-records-producer',
              sequence: producerTurn.userTurnSequence + 1,
              parentTurnRef: producerTurn.userTurnId ?? undefined,
              effectReceiptRef: producerTurn.requestId,
              sourceRefs: [producerTurn.submission.resultAddress],
              correlationRefs: [producerTurn.userTurnId, producerTurn.ledgerConversationId, producerTurn.requestId].filter((ref): ref is string => Boolean(ref)),
              timestamp: completedAt,
            };

            setPendingConversation((current) => current ? {
              ...current,
              messages: [...current.messages, assistantMessage],
            } : current);

            // Republish the complete in-app turn set so the canonical message page
            // remains whole; duplicate turn addresses are idempotent durable writes.
            if (producerTurn.ledgerConversationId && producerTurn.userTurnId) {
              try {
                const assistantTurnDraft: ChatAddressedExchangeTurnDraft = {
                  turnId: assistantTurnRef,
                  conversationId: producerTurn.ledgerConversationId,
                  parentTurnId: producerTurn.userTurnId,
                  sequence: producerTurn.userTurnSequence + 1,
                  role: 'assistant',
                  content: displayText,
                  createdAt: completedAt,
                  speakerRef: producerTurn.agentRef || 'ai-records-producer',
                  authorRef: producerTurn.agentRef || 'ai-records-producer',
                  sourceRefs: [producerTurn.submission.resultAddress],
                  correlationRefs: [producerTurn.userTurnId, producerTurn.ledgerConversationId, producerTurn.requestId],
                  effectReceiptRef: producerTurn.requestId,
                };
                const completeTurnDrafts = mergeAddressedExchangeTurnDrafts(
                  [...producerTurn.canonicalTurnDrafts, assistantTurnDraft],
                  producerTurn.ledgerConversationId,
                );
                await writeAddressedExchangeThroughConversations({
                  conversation: {
                    conversationId: producerTurn.ledgerConversationId,
                    participantRefs: producerTurn.ledgerParticipantRefs,
                    wayRefs: producerTurn.ledgerWayRefs,
                    serviceConnectionRefs: producerTurn.ledgerServiceConnectionRefs,
                    title: producerTurn.ledgerConversationTitle ?? producerTurn.ledgerConversationId,
                    lastMessagePreview: displayText,
                    lastActivityAt: completedAt,
                    createdAt: producerTurn.ledgerConversationCreatedAt ?? undefined,
                    updatedAt: completedAt,
                    messagePageRef: `message-page:${producerTurn.ledgerConversationId}`,
                    cursorRef: assistantTurnRef,
                    projectSlug: producerTurn.ledgerProjectSlug ?? undefined,
                    projectName: producerTurn.ledgerProjectLabel ?? undefined,
                  },
                  turns: completeTurnDrafts,
                  messagePageRef: `message-page:${producerTurn.ledgerConversationId}`,
                  nextCursorRef: assistantTurnRef,
                });
              } catch (recordError) {
                console.error('Failed to record turn to ledger:', recordError);
                setRetrySendContent(producerTurn.userText);
                setActionError((current) => current ?? 'Failed to save chat.');
              }
            }

            setIsProcessing(false);
          }
        } else if (status.state === 'error') {
          if (!cancelled) {
            setProducerTurn((current) => { if (current?.capabilityAuthorization) expireRoundAuthorization(current.capabilityAuthorization); return current ? { ...current, state: 'error', errorMessage: 'The reply could not be completed. Try again.' } : current; });
            setActionError('The reply could not be completed. Try again.');
            setIsProcessing(false);
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.error('[chat] producer status handling failed:', error);
          const humanMessage = 'The reply could not be completed. Try again.';
          setProducerTurn((current) => { if (current?.capabilityAuthorization) expireRoundAuthorization(current.capabilityAuthorization); return current ? { ...current, state: 'error', errorMessage: humanMessage } : current; });
          setActionError(humanMessage);
          setIsProcessing(false);
        }
      }
    };

    void handleStatus();

    return () => {
      cancelled = true;
      roundAbort.abort();
    };
  }, [producerStatus, producerTurn]);

  useEffect(() => {
    if (!liveTurn || liveTurn.state === 'running') return;
    if (finalizingLiveTurnRef.current === liveTurn.processSessionId) return;

    finalizingLiveTurnRef.current = liveTurn.processSessionId;
    let cancelled = false;

    const finalize = async () => {
      logLiveTurnDiagnostic('finalize-start', {
        elapsedMs: elapsedMsSince(liveTurn.startedAtMs),
        processSessionId: liveTurn.processSessionId,
        state: liveTurn.state,
        exitCode: liveTurn.exitCode,
        outputTextLength: liveTurn.outputText.length,
      });
      const resolvedSourceSessionRef = resolveSourceSessionRefFromLiveOutput(
        liveTurn.input,
        liveTurn.outputText,
      );
      const assistantText = extractLiveAssistantText(
        liveTurn.outputText,
        liveTurn.input.adapter.streamParseSpec ?? EMPTY_STREAM_PARSE_SPEC,
      );
      let assistantContent = assistantText;
      // Legacy process-session transcripts are display-only. The producer turn
      // above is the sole authorized capability path; this branch never dispatches.
      const assistantTurnId = liveTurn.ledgerConversationId
        ? `cc-turn:assistant:${liveTurn.processSessionId}`
        : `pending-agent:${liveTurn.processSessionId}`;
      const assistantMessage: AgentMessage | null = assistantContent
        ? {
            id: assistantTurnId,
            type: 'text',
            content: assistantContent,
            role: 'assistant',
            timestamp: new Date().toISOString(),
          }
        : null;

      setPendingConversation((current) => {
        if (!current) return current;
        const hasAssistantMessage = assistantMessage
          ? current.messages.some((message) => message.id === assistantMessage.id)
          : false;
        return {
          ...current,
          sourceSessionRef: resolvedSourceSessionRef ?? current.sourceSessionRef,
          messages: assistantMessage && !hasAssistantMessage
            ? [...current.messages, assistantMessage]
            : current.messages,
        };
      });

      if (liveTurn.state === 'failed' || (liveTurn.exitCode !== null && liveTurn.exitCode !== 0)) {
        console.error('[chat] response failed:', liveTurn.failureReason ?? boundedProcessDiagnostic(liveTurn.outputText));
        setActionError('The reply could not be completed. Try again.');
      }

      let latestTranscriptPageLoaded = false;
      if (liveTurn.sourcePath) {
        try {
          const selectedTranscriptStartedAtMs = monotonicNowMs();
          const submittedMessage: AgentMessage = {
            id: `submitted:${liveTurn.processSessionId}`,
            type: 'text',
            content: liveTurn.input.prompt,
            role: 'human',
            timestamp: liveTurn.startedAt,
          };
          const { matched, page: latestPage } = await readLatestSourceTranscriptPageUntilResponse(
            liveTurn.sourcePath,
            submittedMessage,
            {
              sessionId: liveTurn.selectedSessionId,
            },
          );
          latestTranscriptPageLoaded = true;
          if (!cancelled) {
            setTranscriptPage(latestPage);
            setTranscriptPageError(null);
          }
          logLiveTurnDiagnostic('finalize-selected-transcript-page-complete', {
            elapsedMs: elapsedMsSince(liveTurn.startedAtMs),
            processSessionId: liveTurn.processSessionId,
            readMs: elapsedMsSince(selectedTranscriptStartedAtMs),
            lineCount: latestPage.lines.length,
            matched,
          });
        } catch (transcriptError) {
          logLiveTurnDiagnostic('finalize-selected-transcript-page-failed', {
            elapsedMs: elapsedMsSince(liveTurn.startedAtMs),
            processSessionId: liveTurn.processSessionId,
            message: errorWords(transcriptError),
          });
          if (!cancelled) {
            setTranscriptPageError('The latest messages could not be opened. Try again.');
          }
        }
      }

      try {
        const refreshStartedAtMs = monotonicNowMs();
        await refreshChatHistory();
        logLiveTurnDiagnostic('finalize-refresh-complete', {
          elapsedMs: elapsedMsSince(liveTurn.startedAtMs),
          processSessionId: liveTurn.processSessionId,
          refreshMs: elapsedMsSince(refreshStartedAtMs),
        });
      } catch (scanError) {
        logLiveTurnDiagnostic('finalize-refresh-failed', {
          elapsedMs: elapsedMsSince(liveTurn.startedAtMs),
          processSessionId: liveTurn.processSessionId,
          message: errorWords(scanError),
        });
        if (!latestTranscriptPageLoaded) {
          setActionError((current) => current ?? 'Your conversations could not be refreshed. Try again.');
        }
      }

      if (!cancelled) {
        setIsProcessing(false);
        setLiveTurn(null);
        finalizingLiveTurnRef.current = null;
        logLiveTurnDiagnostic('finalize-complete', {
          elapsedMs: elapsedMsSince(liveTurn.startedAtMs),
          processSessionId: liveTurn.processSessionId,
        });
      }
    };

    void finalize();

    return () => {
      cancelled = true;
    };
  }, [liveTurn]);

  const handleStop = useCallback(() => {
    // Stop the current producer-backed turn.
    const snapshot = inFlightCapability;
    setProducerTurn((current) => {
      if (current?.capabilityAuthorization) expireRoundAuthorization(current.capabilityAuthorization);
      const message = snapshot?.state !== 'dispatched'
        ? 'User cancelled'
        : snapshot.action.cancellationCapabilityRef
          ? 'Cancellation requested…'
          : 'Still running; this work has no current cancellation capability.';
      return current ? { ...current, state: 'error', errorMessage: message } : current;
    });
    void cancelInFlightCapability({ inFlight: snapshot }).then((state) => {
      setProducerTurn((current) => current ? { ...current, errorMessage: state === 'cancellation-requested' ? 'Cancellation requested…' : state === 'still-running' ? 'Still running; this work has no current cancellation capability.' : 'User cancelled' } : current);
      setInFlightCapability(null);
    }).catch(() => setProducerTurn((current) => current ? { ...current, errorMessage: 'Still running; cancellation could not be verified.' } : current));
    setIsProcessing(false);
    void refreshChatHistory().catch((scanError) => {
      setActionError((existing) => existing ?? 'Your conversations could not be refreshed. Try again.');
    });
  }, [inFlightCapability]);

  const activeSessionParticipantRefs = activeSession
    ? (activeSession.participantRefs.length > 0 ? activeSession.participantRefs : [activeSession.participantRef].filter(Boolean))
    : [];
  const selectedParticipantRef = activeSessionParticipantRefs[0]
    ?? (pendingConversation && !pendingConversation.ledgerConversationId ? pendingConversation.participantRef : chatConfig.participantRef);
  const selectedParticipantRefs = activeSessionParticipantRefs.length > 0
    ? activeSessionParticipantRefs
    : pendingConversation && !pendingConversation.ledgerConversationId
      ? (pendingConversation.participantRefs.length > 0 ? pendingConversation.participantRefs : [pendingConversation.participantRef])
      : chatConfig.participantRefs.length > 0
        ? chatConfig.participantRefs
        : [chatConfig.participantRef].filter(Boolean);
  const selectedAccountDir = activeSession?.accountDir
    ?? (pendingConversation && !pendingConversation.ledgerConversationId ? pendingConversation.accountDir : null);
  const selectedModelForConfig = activeSession && chatConfig.participantRef !== selectedParticipantRef
    ? activeSession.model
    : chatConfig.model;
  const sessionParticipantInfo = useMemo(() => makeSessionParticipantInfo(
    selectedParticipantRef,
    selectedAccountDir,
    selectedModelForConfig,
  ), [selectedAccountDir, selectedParticipantRef, selectedModelForConfig]);
  const selectedParticipantInfo = participantInfoByRef.get(selectedParticipantRef) ?? sessionParticipantInfo ?? undefined;
  const selectedParticipantInfos = selectedParticipantRefs
    .map((participantRef) => {
      const info = participantInfoByRef.get(participantRef);
      const label = presentedParticipants.find(participant => participant.participantRef === participantRef)?.label;
      return info && label && label !== info.label ? { ...info, label } : info;
    })
    .filter((participant): participant is AddressedParticipantInfo => Boolean(participant));
  const selectedAccount = findAddressedParticipantAccount(
    selectedParticipantInfo,
    activeSession ? null : chatConfig.accountId || null,
    selectedAccountDir,
  );
  const configBarParticipants = useMemo(() => {
    if (!sessionParticipantInfo) return presentedParticipants;
    if (presentedParticipants.some((participant) => participant.participantRef === sessionParticipantInfo.participantRef)) return presentedParticipants;
    return [sessionParticipantInfo, ...presentedParticipants];
  }, [presentedParticipants, sessionParticipantInfo]);
  const configBarConfig = useMemo<ChatSessionConfig>(() => {
    if (!activeSession && !pendingConversation) return chatConfig;
    return normalizeChatSessionConfig({
      participantRefs: selectedParticipantRefs,
      accountId: selectedAccount?.id ?? selectedAccountDir ?? '',
      model: selectedModelForConfig,
    });
  }, [
    activeSession,
    chatConfig,
    pendingConversation,
    selectedAccount?.id,
    selectedAccountDir,
    selectedParticipantRef,
    selectedParticipantRefs,
    selectedModelForConfig,
  ]);
  // An app that offers one assistant has nothing to choose between, so the
  // whole config bar goes: the picker, the browse-participants button, and the
  // presets. Absent means every app that has not said otherwise keeps all of
  // it, which is every app today.
  const offersAChoiceOfWhoAnswers = surfaceInput?.offers_a_choice_of_who_answers !== false;
  const canChangeProviderSelection = offersAChoiceOfWhoAnswers && canChangeChatProviderSelection({
    activeSessionId,
    pendingConversationLedgerId: pendingConversation?.ledgerConversationId ?? null,
    hasPendingConversation: Boolean(pendingConversation),
    isProcessing,
  });

  const displaySessionId = activeSession?.sessionId
    ?? pendingConversation?.ledgerConversationId
    ?? pendingConversation?.sourceSessionRef
    ?? null;
  const displayParticipantRef = activeSessionParticipantRefs.length > 0
    ? activeSessionParticipantRefs.join(', ')
    : (pendingConversation && !pendingConversation.ledgerConversationId
      ? pendingConversation.participantRef
      : (chatConfig.participantRefs.length > 0 ? chatConfig.participantRefs.join(', ') : chatConfig.participantRef));
  const displayAccountLabel = activeSession?.accountDir
    ?? (pendingConversation && !pendingConversation.ledgerConversationId ? pendingConversation.accountDir : null)
    ?? selectedAccount?.label
    ?? null;
  const displayProjectLabel = activeSession?.projectName
    ?? pendingConversation?.projectLabel
    ?? currentProjectFeed.activeProject
    ?? null;

  // #57 — WHO actually spoke in THIS conversation + WHO LAST SPOKE, read from the
  // canonical turns (the SSOT for per-turn participant identity; the rendered
  // AgentMessage deliberately drops it). The model can change per turn, so the
  // roster + last-speaker come from the turns, never the next-turn selection.
  // Re-reads when the conversation projection switches or a turn completes.
  const [conversationRoster, setConversationRoster] = useState<{ refs: readonly string[]; last: string }>({ refs: [], last: '' });
  useEffect(() => {
    if (!displaySessionId || !displaySessionId.startsWith('addressed-exchange:')) {
      setConversationRoster({ refs: [], last: '' });
      return;
    }
    const turns = canonicalConversations.messagesBySession[displaySessionId] ?? [];
    const order: string[] = [];
    let last = '';
    for (const turn of turns) {
      const ref = (turn.speakerRef ?? '').replace(/^addressed-participant:/, '');
      if (!ref || ref === 'user') continue;
      last = ref;
      if (!order.includes(ref)) order.push(ref);
    }
    setConversationRoster({ refs: order, last });
  }, [canonicalConversations.messagesBySession, displaySessionId, isProcessing]);

  const browseParticipantsButton = presentedParticipants.length > 0 ? (
    <Tooltip label="Choose participants">
      <ActionControl
        variant="ghost"
        size="sm"
        onClick={() => setIsParticipantBrowserOpen(true)}
        aria-label="Choose participants"
      >
        <Icon icon={Users} size="sm" />
      </ActionControl>
    </Tooltip>
  ) : null;

  const openParticipantSetupForm = useCallback((participant: AddressedParticipantInfo) => {
    const setupRouteRef = participant.setupRouteRefs[0];
    const setupRoute = participant.routeDescriptors.find((route) => route.routeRef === setupRouteRef)
      ?? participant.routeDescriptors.find((route) => route.setupDescriptor)
      ?? null;
    const setupDescriptor = setupRoute?.setupDescriptor ?? null;
    if (!setupRouteRef || !setupRoute || !setupDescriptor || setupDescriptor.fields.length === 0) {
      setActionError("This participant doesn't have a setup form.");
      return;
    }
    if (!setupRoute.targetRef) {
      setActionError("This participant isn't ready to set up yet.");
      return;
    }
    setActionError(null);
    setPendingSetupForm({
      participant,
      routeRef: setupRoute.routeRef,
      fieldValues: Object.fromEntries(setupDescriptor.fields.map((field) => [field.id, ''])),
      submitting: false,
    });
  }, []);

  const submitPendingSetupForm = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pendingSetupForm) return;
    const participant = pendingSetupForm.participant;
    const setupRoute = participant.routeDescriptors.find((route) => route.routeRef === pendingSetupForm.routeRef);
    const setupDescriptor = setupRoute?.setupDescriptor ?? null;
    const serviceConnectionRef = participant.serviceConnectionRefs[0] ?? null;
    if (!setupRoute || !setupDescriptor || !serviceConnectionRef) {
      setActionError("This participant's setup form is incomplete.");
      return;
    }
    setPendingSetupForm((current) => current ? { ...current, submitting: true } : current);
    void loadChatSendWork().then(work => work.submitConnectAction({
      participantRef: participant.participantRef,
      wayRef: participant.wayToReachRef,
      serviceConnectionRef,
      setupRoute,
      setupDescriptor,
      fieldValues: pendingSetupForm.fieldValues,
      correlationRefs: [participant.participantRef, setupRoute.routeRef],
    }))
      .then((reply) => {
        const result = classifyConnectSubmitReply(reply);
        if (result.kind === 'connected') {
          setPendingSetupForm(null);
          setActionError(null);
          return;
        }
        if (result.kind === 'pending') {
          setActionError(null);
          setPendingSetupForm((current) => current ? { ...current, submitting: true } : current);
          return;
        }
        setActionError(result.message);
        setPendingSetupForm((current) => current ? { ...current, submitting: false } : current);
      })
      .catch((error) => {
        console.error('[chat] submit setup failed:', error);
        setActionError('Setup could not be saved. Try again.');
        setPendingSetupForm((current) => current ? { ...current, submitting: false } : current);
      });
  }, [pendingSetupForm]);

  const setupFormOverlay = pendingSetupForm ? (() => {
    const participant = pendingSetupForm.participant;
    const setupRoute = participant.routeDescriptors.find((route) => route.routeRef === pendingSetupForm.routeRef);
    const fields = setupRoute?.setupDescriptor?.fields ?? [];
    // One-click contract (reference: Pipedream/Zapier connect modals): when no
    // field is required, Connect works immediately — optional fields read as
    // skippable, never as homework. A guided field shows its exact numbered
    // steps and a deep-link button to the provider page.
    const allOptional = fields.every((field) => !field.required);
    const guideField = fields.find((field) => field.guideSteps.length > 0) ?? null;
    return (
      <FloatingPanel
        open
        onClose={() => setPendingSetupForm(null)}
        title={`Connect ${participant.label}`}
        width={448}
      >
        <Form onSubmit={submitPendingSetupForm}>
          <Container layout="vertical" gap="md" padding="none">
            <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
              <DisplayMark spec={participantToMarkSpec(participant)} size="md" />
              <Container layout="vertical" gap="none" padding="none">
                <Text variant="label" color="strong" truncate>{participant.label}</Text>
                {allOptional ? (
                  <Text variant="body-xs" color="muted">Ready to connect.</Text>
                ) : null}
              </Container>
            </Container>
            {guideField?.guideSteps.length ? (
              <Card variant="nested" padding="sm">
                <Container layout="vertical" gap="xs" padding="none">
                  {guideField.guideSteps.map((step, stepIndex) => (
                    <Container key={step} layout="horizontal" gap="sm" alignItems="start" padding="none">
                      <Badge variant="neutral" size="sm">{stepIndex + 1}</Badge>
                      <Text variant="body-xs" color="secondary">{step}</Text>
                    </Container>
                  ))}
                  {guideField.guideUrl ? (
                    <Container layout="horizontal" justifyContent="start" padding="none">
                      <ActionControl
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => window.open(guideField.guideUrl ?? '', '_blank', 'noopener')}
                      >
                        <Icon icon={ExternalLink} size="xs" />
                        Open {new URL(guideField.guideUrl).hostname.replace(/^www\./, '')}
                      </ActionControl>
                    </Container>
                  ) : null}
                </Container>
              </Card>
            ) : null}
            {fields.map((field) => (
              <Input
                key={field.id}
                type={field.secret ? 'password' : 'text'}
                label={field.required ? field.label : `${field.label} — optional`}
                value={pendingSetupForm.fieldValues[field.id] ?? ''}
                required={field.required}
                placeholder={field.placeholder ?? undefined}
                autoComplete={field.autocomplete ?? undefined}
                hint={field.help ?? undefined}
                onChange={(inputEvent) => {
                  const nextValue = inputEvent.target.value;
                  setPendingSetupForm((current) => current ? {
                    ...current,
                    fieldValues: {
                      ...current.fieldValues,
                      [field.id]: nextValue,
                    },
                  } : current);
                }}
              />
            ))}
            {actionError ? (
              <Text variant="body-sm" color="error" wrap="preserve">
                {actionError}
              </Text>
            ) : null}
            <Container layout="horizontal" gap="sm" justifyContent="end" padding="none">
              <ActionControl
                variant="ghost"
                type="button"
                onClick={() => setPendingSetupForm(null)}
                disabled={pendingSetupForm.submitting}
              >
                Cancel
              </ActionControl>
              <ActionControl
                variant="accent"
                type="submit"
                loading={pendingSetupForm.submitting}
                disabled={pendingSetupForm.submitting}
              >
                {pendingSetupForm.submitting ? 'Setting up' : 'Connect'}
              </ActionControl>
            </Container>
          </Container>
        </Form>
      </FloatingPanel>
    );
  })() : null;

  // Opens the profile/people catalog, with executable transports shown only as
  // the no-profile fallback. ONE handler is shared by the zero-agent action,
  // hero connect callout, and browse control. A plain function keeps this late
  // render assembly clear of the hooks-order boundary.
  const openConnectAi = () => setIsParticipantBrowserOpen(true);
  const canConfigureParticipant = (participant: AddressedParticipantInfo) => (
    participantConfigurationIntent(participant, placeableSurfaces) !== null
  );
  const openParticipantConfiguration = (participant: AddressedParticipantInfo) => {
    const intent = participantConfigurationIntent(participant, placeableSurfaces);
    if (!intent) {
      setActionError(`Settings for ${participant.label} are not available in this workspace.`);
      return;
    }
    const accepted = emitPlaceableSurfaceIntent(intent);
    if (!accepted) {
      setActionError(`This workspace could not open settings for ${participant.label}.`);
      return;
    }
    setActionError(null);
    setIsParticipantBrowserOpen(false);
  };

  const configBar = offersAChoiceOfWhoAnswers ? (
    <>
      <UnifiedAgentPicker
        participants={configBarParticipants}
        config={configBarConfig}
        onSelect={selectAgentAndModel}
        onSelectAuto={selectAutoAgent}
        canChange={canChangeProviderSelection}
        onConnect={openConnectAi}
        canConfigureParticipant={canConfigureParticipant}
        onConfigureParticipant={openParticipantConfiguration}
      />
      {browseParticipantsButton}
      {presets.length > 0 && (
        <PresetPopover presets={presets} onSelectPreset={handlePresetSelect} />
      )}
    </>
  ) : null;

  const inputFooter = configBar;

  // Setup is needed only before an assistant is available. The shared sidebar
  // and composer already expose optional participants once connected.
  const heroConnectCallout = configBarParticipants.length === 0 ? (
    <ChatConnectAiCallout
      intent="prominent"
      onConnect={openConnectAi}
    />
  ) : null;

  const transcriptWindowControls = activeSession?.filePath && selectedTranscriptPage && (selectedTranscriptPage.lines.length > 0 || selectedTranscriptPage.has_older) ? (
    <Card variant="nested" padding="sm" borderless>
      <Container layout="horizontal" wrap="wrap" gap="sm" alignItems="center" justifyContent="between" padding="none">
        <Text variant="caption" color="faint">
          {selectedTranscriptPage.has_newer
            ? `Showing ${selectedTranscriptPage.lines.length} earlier messages`
            : selectedTranscriptPage.total_count_known && selectedTranscriptPage.total_count !== null
            ? `Showing ${selectedTranscriptPage.lines.length} of ${selectedTranscriptPage.total_count} messages`
            : `Showing the latest ${selectedTranscriptPage.lines.length} messages`}
        </Text>
        {selectedTranscriptPage.has_newer && (
          <ActionControl variant="ghost" size="sm" onClick={handleShowLatestTranscriptPage} disabled={transcriptPageLoading}>
            Show latest
          </ActionControl>
        )}
        {selectedTranscriptPage.has_older && (selectedTranscriptPage.older_cursor != null || selectedTranscriptPage.start_index !== null) && (
          <ActionControl
            variant="ghost"
            size="sm"
            onClick={handleLoadOlderTranscriptPage}
            disabled={transcriptPageLoading}
          >
            {transcriptPageLoading ? 'Loading…' : 'Load earlier'}
          </ActionControl>
        )}
      </Container>
    </Card>
  ) : null;

  // Active-turn status for the Cursor-style agent/model header chip strip (#40).
  // The turn state is the SSOT here; the strip is a blind projection of it.
  const agentTurnDescriptor: AgentTurnDescriptor | null = producerTurn
    ? producerTurn.state === 'pending'
      ? { phase: 'working', startedAtMs: producerTurn.startedAtMs }
      : producerTurn.state === 'error'
        ? { phase: 'error', ...(producerTurn.errorMessage ? { message: producerTurn.errorMessage } : {}) }
        : { phase: 'done' }
    : isProcessing
      ? { phase: 'working' }
      : null;
  const agentSessions = buildAgentStatusSessions(agentTurnDescriptor, selectedParticipantInfos);

  // Rendered in BOTH the empty/hero and the active returns — it is a portal modal
  // (null when closed), so the browse control works on the very first screen too.
  const participantBrowserOverlay = (
    <>
      {isParticipantBrowserOpen ? <React.Suspense fallback={null}><ParticipantBrowser
        open={isParticipantBrowserOpen}
        onClose={() => setIsParticipantBrowserOpen(false)}
        participants={presentedParticipants}
        selectedParticipantRefs={chatConfig.participantRefs.length > 0 ? chatConfig.participantRefs : [chatConfig.participantRef].filter(Boolean)}
        onSelectParticipant={(participantRef) => {
          setParticipant(participantRef);
        }}
        onDone={() => setIsParticipantBrowserOpen(false)}
        onConnectParticipant={openParticipantSetupForm}
        canConfigureParticipant={canConfigureParticipant}
        onConfigureParticipant={openParticipantConfiguration}
      /></React.Suspense> : null}
      {setupFormOverlay}
    </>
  );

  const mode = getViewMode(activeSessionId, !!pendingConversation);
  const draftScope = JSON.stringify(['personal', surfaceInput?.authority_ref ?? null,
    activeSessionId ?? 'new', chatConfig.participantRef, chatConfig.accountId]);

  // The DETAIL pane content: the hero start screen when nothing is open, the
  // live transcript + composer when a conversation is active. Same node feeds
  // the 3-pane shell's `detail` slot in both modes.
  const backToList = (
    <Container className="chat-panes-back" padding="xs">
        <ActionControl variant="ghost" size="sm" onClick={() => setNarrowPane('list')} title="Back to conversations">
          <Icon icon={ArrowLeft} size="xs" color="ghost" />
          Conversations
        </ActionControl>
    </Container>
  );
  const detail = embeddedFocusConversation && !embeddedFocusSession ? (
    <ScreenState state={sessionsEntry
      ? { status: 'unavailable', title: 'This conversation is not available', description: 'Open it again from your conversations.' }
      : { status: 'loading', label: 'Loading your conversation', layout: 'rows' }} />
  ) : mode === 'empty' ? (
    <Container layout="vertical" overflow="hidden" flex={1} minHeight="0" data-reach-role="empty-state">
      {backToList}
      <ChatHeroState
        draftScope={draftScope}
        configBar={configBar}
        onSend={handleSend}
        connectCallout={heroConnectCallout}
        belowInput={actionError ? (
          <ChatErrorBanner
            error={actionError}
            onDismiss={() => setActionError(null)}
            onRetry={retrySendContent ? handleRetrySend : retryProviderSelection !== null ? handleRetryProviderSelection : undefined}
          />
        ) : undefined}
        activePreset={activePreset}
        onPresetDismiss={handlePresetDismiss}
        selectedContext={selectedContext}
        prefillValue={composerPrefill}
        onPrefillConsumed={handleComposerPrefillConsumed}
      />
    </Container>
  ) : (
    <Container layout="vertical" overflow="hidden" flex={1} minHeight="0" position="relative" data-reach-role="message-view">
      {backToList}
      {displaySessionId && (
        <SessionMetaBar
          participantRef={displayParticipantRef}
          participantInfos={selectedParticipantInfos}
          accountLabel={displayAccountLabel}
          projectLabel={displayProjectLabel}
          messages={messages}
          conversationSpeakerRefs={conversationRoster.refs}
          lastSpeakerRef={conversationRoster.last}
          hasPlan={hasPlanSidebar}
          onOpenPlan={() => setIsPlanSidebarOpen(true)}
          onOpenParticipants={() => setIsParticipantBrowserOpen(true)}
          agentSessions={agentSessions}
        />
      )}
      <ChatTeammateBar teammates={teammates} />
      <ChatPanel
        draftScope={draftScope}
        onTyping={onTyping}
        key={`${typeof surfaceInput?.transcriptSessionId === 'string' ? activeDecoderSessionId : activeSessionId ?? pendingConversation?.sourceSessionRef ?? 'new-chat'}:${transcriptVisit}`}
        sessionId={typeof surfaceInput?.transcriptSessionId === 'string' ? activeDecoderSessionId : activeSessionId ?? pendingConversation?.sourceSessionRef}
        restoreScroll={typeof surfaceInput?.transcriptSessionId !== 'string'}
        messages={messagesForPanel}
        placeableSurfaceCatalog={placeableSurfaces}
        surfaceIntentDestinationRef={surfaceIntentDestinationRef}
        reactionPalette={annotationPalette.reactionPalette}
        messageActions={messageActions}
        onMessageIntent={handleMessageIntent}
        onMessagePerform={handleMessagePerform}
        onSend={handleSend}
        inputMode={inputMode}
        isStreaming={isProcessing}
        inputDisabled={isProcessing}
        inputFooter={inputFooter}
        beforeMessages={transcriptWindowControls}
        belowInput={(actionError ?? transcriptPageError) ? (
          <ChatErrorBanner
            error={actionError ?? transcriptPageError ?? ''}
            onRetry={actionError && retrySendContent ? handleRetrySend : actionError && retryProviderSelection !== null ? handleRetryProviderSelection : undefined}
            onDismiss={() => {
              setActionError(null);
              setTranscriptPageError(null);
            }}
          />
        ) : undefined}
        activePreset={activePreset}
        onPresetDismiss={handlePresetDismiss}
        onStop={isProcessing ? handleStop : undefined}
        selectedContext={selectedContext}
        prefillValue={composerPrefill}
        onPrefillConsumed={handleComposerPrefillConsumed}
      />
      {hasPlanSidebar && (
        <PlanSidebar
          steps={planSteps}
          isOpen={isPlanSidebarOpen}
          onClose={() => setIsPlanSidebarOpen(false)}
          planContent={exitPlanPayload.planContent}
          planPreamble={exitPlanPayload.planPreamble}
        />
      )}
    </Container>
  );

  return (
    <Container data-guided-overlay-target="chat-current-work" layout="horizontal" overflow="hidden" flex={1} height="full" minHeight="0" className="chat-panes" data-pane={narrowPane}>
      {participantBrowserOverlay}
      {/* A host that lists the conversations itself (Trillion's sidebar) asks for no sections, and the chat draws only
          the conversation. */}
      {Array.isArray(surfaceInput?.navigationSections) && surfaceInput.navigationSections.length === 0 ? null : <ConversationNavigation instanceId={`chat:${navigationInstanceId}`} sessions={sessions} selectedId={activeSessionId}
        onSelect={id => { handleSelectHistorySession(id); setNarrowPane('detail'); }} onNewChat={() => { handleNewChat(); setNarrowPane('detail'); }}
        historyUnavailable={Boolean(sessionsEntry && typeof sessionsEntry === 'object' && 'unavailable_sources' in sessionsEntry
          && Array.isArray(sessionsEntry.unavailable_sources) && sessionsEntry.unavailable_sources.length > 0)}
        onRetryHistory={refreshChatHistory}
        hasOlderConversations={conversationPages.hasMore} loadingOlderConversations={conversationPages.loading}
        olderConversationsError={conversationPages.error} onLoadOlderConversations={conversationPages.loadOlder}
        sectionKinds={Array.isArray(surfaceInput?.navigationSections) ? surfaceInput.navigationSections.filter((value): value is string => typeof value === 'string') : undefined}
        primaryAssistant={(() => {
          const requested = explicitParticipantRef || defaultParticipantRef;
          const assistant = requested ? presentedParticipants.find(p => p.participantRef === requested)
            : presentedParticipants.find(p => p.adapter?.ownerTargetRef);
          return assistant ? { id: assistant.participantRef, label: assistant.label } : undefined;
        })()}
        participantMarks={presentedParticipants}
        participants={presentedParticipants.map(p => ({ id: p.participantRef, label: p.label,
          kind: presentedAgentParticipants.some(agent => agent.participantRef === p.participantRef) ? 'agents' : 'people' }))}
        onSelectParticipant={id => { handleNewChat(); selectAgentAndModel(id, null); }} />}
      {detail}
    </Container>
  );
}

export function ChatView(props: ChatViewProps) {
  const subject = typeof props.surfaceInput?.subject_ref === 'string' ? props.surfaceInput.subject_ref.trim() : '';
  useChatDraftAuthority(subject, typeof props.surfaceInput?.authority_ref === 'string' ? props.surfaceInput.authority_ref : '');
  if (subject) return <PrivateChatView key={subject} subject={subject} surfaceInput={props.surfaceInput} />;
  return <ChatViewContents {...props} />;
}

/** A private placement never mounts personal history, source assembly or agent
 * execution hooks. The exchange owner is the only reader and sender here. */
function PrivateChatView({ subject, surfaceInput }: { subject: string; surfaceInput?: Record<string, unknown> }) {
  const navigationInstanceId = React.useId();
  const owner = usePrivateConversations(subject);
  const workEntry = useBitfieldData('operation-records');
  const progressionEntry = useBitfieldData('progression-projections');
  const notificationEntry = useBitfieldData('notification-events');
  const workflowActionRecordsEntry = useBitfieldData('workflow-action-records');
  const workflowActions = useMemo(
    () => findChatWorkflowActions(readPublishedRecords(workflowActionRecordsEntry)),
    [workflowActionRecordsEntry],
  );
  const [selected, setSelected] = useState<string | null>(
    typeof surfaceInput?.focusConversation === 'string' ? surfaceInput.focusConversation : null,
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ conversation: string; content: string; turn: string; correction: ConversationCorrectionAction | null } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const sessions = owner.data?.sessions ?? [];
  const active = sessions.find((session) => session.recordId === selected) ?? sessions[0];
  const conversation = active?.recordId ?? null;
  const activeConversation = useRef(conversation);
  activeConversation.current = conversation;
  const messages = conversation ? owner.data?.messagesBySession[conversation] ?? [] : [];
  const work = useMemo(
    () => projectConversationWork(workEntry, conversation, subject, workflowActions, progressionEntry),
    [conversation, progressionEntry, subject, workEntry, workflowActions],
  );
  const notifications = useMemo(
    () => conversation ? projectConversationNotifications(notificationEntry, subject, conversation) : [],
    [conversation, notificationEntry, subject],
  );
  const visibleMessages = useMemo(() => [...messages, ...work.messages, ...notifications], [messages, notifications, work.messages]);
  const frontier = messages.length ? messages[messages.length - 1].sequence : null;
  useEffect(() => {
    if (conversation && typeof frontier === 'number') void owner.acknowledge(conversation, frontier + 1);
  }, [conversation, frontier, owner.acknowledge]);
  const send = async (value: string, destination = conversation): Promise<boolean> => {
    const content = value.trim();
    if (!content || !destination || inFlight.current) return false;
    const conversation = destination;
    const previous = pending.current;
    const turn = previous?.conversation === conversation && previous.content === content
      ? previous.turn : createChatAddressedExchangeTurnId();
    const correction = previous?.conversation === conversation && previous.content === content
      ? previous.correction : work.correction;
    pending.current = { conversation, content, turn, correction };
    inFlight.current = true; setSending(true); setError(null);
    try {
      const appended = await invokePrivateConversation({ operation: 'append', subject_ref: subject,
        conversation_ref: conversation, turn_ref: turn, content,
        source_refs: [conversation, turn], correlation_refs: [conversation, turn],
        ...(correction ? { correction_request: {
          work_ref: correction.operation.id,
          expected_owner_revision: correction.transition.input.expected_owner_revision,
        } } : {}) }) as Record<string, unknown>;
      if (correction) {
        if (typeof appended.correction_handoff_ref !== 'string' || !appended.correction_handoff_ref) {
          throw new Error('The correction message was saved without its work binding.');
        }
        await invokeOperationTransition(correction.operation, {
          ...correction.transition,
          input: {
            ...correction.transition.input,
            review_reason: content,
            subject_ref: subject,
            conversation_ref: conversation,
            correction_turn_ref: turn,
            correction_handoff_ref: appended.correction_handoff_ref,
          },
        }, correction.claim);
      }
      pending.current = null;
      if (mounted.current) await owner.reload();
      return true;
    } catch (cause) {
      if (mounted.current && activeConversation.current === conversation) setError('Your message was not acknowledged. Try again.');
      return false;
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  };
  const perform = useCallback<MessagePerformHandler>((message, control) => executeMessagePerformControl({
    message,
    control,
    workflowActions,
    callerAuthorityRef: typeof surfaceInput?.authority_ref === 'string' ? surfaceInput.authority_ref : '',
    partitionKey: 'runtime-partition',
  }), [surfaceInput?.authority_ref, workflowActions]);
  return <Container data-guided-overlay-target="chat-current-work" layout="horizontal" overflow="hidden" flex={1} height="full" minHeight="0">
    <ConversationNavigation instanceId={`chat:${subject}:${navigationInstanceId}`} sessions={sessions} selectedId={conversation}
      onSelect={(id) => { setSelected(id); setError(null); }} />
    <Container layout="vertical" overflow="hidden" flex={1} minHeight="0" data-reach-role="message-view">
      <ChatPanel key={conversation ?? subject} sessionId={conversation} messages={visibleMessages}
        draftScope={typeof surfaceInput?.authority_ref === 'string' && surfaceInput.authority_ref
          ? JSON.stringify(['private', surfaceInput.authority_ref, subject, conversation]) : undefined}
        onMessagePerform={perform}
        onSend={send} inputDisabled={!conversation || sending || !!owner.error}
        inputFooter={active ? <Text variant="caption">{active.title}</Text> : <Text variant="caption">{owner.loading ? 'Opening conversations…' : 'No conversations in this room.'}</Text>}
        belowInput={error || owner.error ? <ChatErrorBanner error={error ?? owner.error ?? ''}
          onRetry={() => { if (pending.current) void send(pending.current.content, pending.current.conversation); else void owner.reload(); }}
          onDismiss={() => setError(null)} /> : undefined} />
    </Container>
  </Container>;
}
