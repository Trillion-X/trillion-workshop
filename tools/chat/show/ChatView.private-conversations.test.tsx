// PORTED FROM: bitfield-packages/packages/chat/show/ChatView.private-conversations.test.tsx @ e99ac5976
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const availableDescriptors = [{ kind: 'ai-model-descriptor', id: 'ai-model-descriptor:local-test',
  provider_ref: 'provider:test-fixture', model_id: 'test', status: 'available' }];

const state = vi.hoisted(() => ({
  reload: vi.fn(), acknowledge: vi.fn(), send: vi.fn(), personal: vi.fn(), privateRead: vi.fn(),
  bitfield: vi.fn(), correct: vi.fn(), readPage: vi.fn(), readConversations: vi.fn(),
  writeConversation: vi.fn(), submitProducer: vi.fn(),
  sendAcceptance: vi.fn(),
}));
vi.mock('../do-work/write-addressed-exchange-through-conversations', async importOriginal => ({
  ...await importOriginal<typeof import('../do-work/write-addressed-exchange-through-conversations')>(),
  writeAddressedExchangeThroughConversations: state.writeConversation,
}));
vi.mock('../do-work/submit-chat-turn-via-producer', async importOriginal => ({
  ...await importOriginal<typeof import('../do-work/submit-chat-turn-via-producer')>(),
  submitChatTurnViaProducer: state.submitProducer,
}));
vi.mock('../do-work/read-chat-conversation-page', () => ({ readChatConversationPage: state.readConversations }));
vi.mock('../do-work/read-chat-transcript-page', async importOriginal => ({
  ...await importOriginal<typeof import('../do-work/read-chat-transcript-page')>(),
  readChatTranscriptPage: state.readPage,
}));
vi.mock('#workspace-records', () => ({ useBitfieldData: state.bitfield }));
vi.mock('../read-data/use-private-conversations', () => ({ usePrivateConversations: state.privateRead }));
vi.mock('../read-data/read-private-conversations', () => ({ invokePrivateConversation: state.send }));
vi.mock('../read-data/use-chat-conversation-projections', () => ({ useChatConversationProjections: state.personal }));
vi.mock('../../operation-records/do-work/invoke-operation-transition', () => ({ invokeOperationTransition: state.correct }));
vi.mock('./ChatPanel', () => ({
  resetChatPanelScrollState: vi.fn(),
  ChatPanel: ({ messages, onSend, belowInput, inputDisabled }: any) => <div>
    {messages.map((message: any) => <p key={message.id}>{message.content}</p>)}
    <button disabled={inputDisabled} onClick={() => void onSend('A correction')}>Send correction</button>
    {belowInput}
  </div>,
}));
vi.mock('./ChatHeroState', () => ({
  ChatHeroState: ({ onSend, configBar, belowInput, connectCallout }: any) => <div>
    {configBar}{connectCallout}
    <button onClick={() => void Promise.resolve(onSend('A correction')).then(state.sendAcceptance)}>Send correction</button>
    {belowInput}
  </div>,
}));
import { ChatView } from './ChatView';

describe('private Chat owner routing', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    state.reload.mockResolvedValue(undefined);
    state.acknowledge.mockResolvedValue(undefined);
    state.send.mockReset().mockResolvedValue({ status: 'accepted', correction_handoff_ref: 'package::conversations::background-work-correction-handoff::turn:test' });
    state.correct.mockReset().mockResolvedValue({ status: 'accepted' });
    state.bitfield.mockImplementation(() => []);
    state.readPage.mockReset();
    state.readConversations.mockReset();
    state.writeConversation.mockReset().mockResolvedValue(undefined);
    state.submitProducer.mockReset().mockResolvedValue({ requestId: 'request:test', resultAddress: 'result:test', errorAddress: 'error:test' });
    state.personal.mockImplementation(() => { throw new Error('Personal data must not mount in private rooms'); });
    state.privateRead.mockImplementation((subject: string) => ({
      data: { sessions: [{ recordId: `conversation:${subject}`, title: subject }],
        messagesBySession: { [`conversation:${subject}`]: [{ id: `turn:${subject}`, content: `Private ${subject}`, sequence: 0 }] },
        unreadByConversation: { [`conversation:${subject}`]: 1 } },
      loading: false, error: null, reload: state.reload, acknowledge: state.acknowledge,
    }));
  });
  it('retries the retained failed send without minting or appending a second human turn', async () => {
    const empty: unknown[] = [];
    let profiles = [{ kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Assistant', model_refs: ['ai-model-descriptor:local-test'], instruction_refs: ['instruction:chat'] }];
    state.personal.mockReturnValue({ sessions: [], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles
      : input === 'chat-model-descriptors' ? availableDescriptors : empty);
    state.writeConversation.mockRejectedValueOnce(new Error('offline'));
    const view = render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary' }} />);
    fireEvent.click(screen.getByText('Send correction'));
    await screen.findByRole('button', { name: 'Retry' });
    expect(state.submitProducer).not.toHaveBeenCalled();
    const first = state.writeConversation.mock.calls[0][0];
    profiles = [{ ...profiles[0], model_refs: ['ai-model-descriptor:changed-after-attempt'] }];
    view.rerender(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(state.submitProducer).toHaveBeenCalledOnce());
    expect(state.writeConversation).toHaveBeenCalledTimes(2);
    expect(state.writeConversation.mock.calls[1][0]).toEqual(first);
    expect(first.turns).toHaveLength(1);
    expect(state.submitProducer.mock.calls[0][0].requestId).toBe(`chat-${first.turns[0].turnId}`);
    expect(state.submitProducer.mock.calls[0][0].modelId).toBe('ai-model-descriptor:local-test');
  });
  it('does not route a configured model without a current descriptor or local inventory', async () => {
    const empty: unknown[] = [];
    const profiles = [{ kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Assistant',
      model_refs: ['ai-model-descriptor:paid'], instruction_refs: ['instruction:chat'] }];
    state.personal.mockReturnValue({ sessions: [], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles : empty);
    render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary' }} />);
    fireEvent.click(screen.getByText('Send correction'));
    await screen.findByText('The selected model is unavailable. Choose an available assistant before sending.');
    await waitFor(() => expect(state.sendAcceptance).toHaveBeenCalledWith(false));
    expect(screen.queryByText('A correction')).toBeNull();
    expect(state.writeConversation).not.toHaveBeenCalled();
    expect(state.submitProducer).not.toHaveBeenCalled();
  });
  it('uses the newly saved hosted model on a fresh draft, without relying on Ollama inventory', async () => {
    const empty: unknown[] = [];
    let profiles = [{ kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Assistant',
      model_refs: ['ai-model-descriptor:local-test'], instruction_refs: ['instruction:chat'] }];
    const descriptors = [{ kind: 'ai-model-descriptor', id: 'ai-model-descriptor:hosted', status: 'available',
      provider_ref: 'provider:remote', model_id: 'hosted', runtime_refs: ['future-runtime'] }];
    state.personal.mockReturnValue({ sessions: [], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles
      : input === 'chat-model-descriptors' ? descriptors : empty);
    const view = render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary' }} />);
    profiles = [{ ...profiles[0], model_refs: ['ai-model-descriptor:hosted'] }];
    view.rerender(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary' }} />);
    fireEvent.click(screen.getByText('Send correction'));
    await waitFor(() => expect(state.submitProducer).toHaveBeenCalledOnce());
    expect(state.submitProducer.mock.calls[0][0].modelId).toBe('ai-model-descriptor:hosted');
  });
  it('refuses retry after original model disappears instead of substituting another model', async () => {
    const empty: unknown[] = [];
    const profiles = [{ kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Assistant',
      model_refs: ['ai-model-descriptor:local-test'], instruction_refs: ['instruction:chat'] }];
    let descriptors = availableDescriptors;
    state.personal.mockReturnValue({ sessions: [], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles
      : input === 'chat-model-descriptors' ? descriptors : empty);
    state.writeConversation.mockRejectedValueOnce(new Error('offline'));
    const view = render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary' }} />);
    fireEvent.click(screen.getByText('Send correction'));
    await screen.findByRole('button', { name: 'Retry' });
    descriptors = [{ kind: 'ai-model-descriptor', id: 'ai-model-descriptor:replacement',
      provider_ref: 'provider:test-fixture', model_id: 'replacement', status: 'available' }];
    view.rerender(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('The selected model is unavailable. Choose an available assistant before sending.');
    expect(state.writeConversation).toHaveBeenCalledTimes(1);
    expect(state.submitProducer).not.toHaveBeenCalled();
  });
  it('keeps reading the original reply and offers no blind resend after a lost dispatch acknowledgement', async () => {
    const empty: unknown[] = [];
    const profiles = [{ kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Assistant', model_refs: ['ai-model-descriptor:local-test'], instruction_refs: ['instruction:chat'] }];
    state.personal.mockReturnValue({ sessions: [], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles
      : input === 'chat-model-descriptors' ? availableDescriptors : empty);
    state.submitProducer.mockRejectedValueOnce(new Error('acknowledgement lost'));
    render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary' }} />);
    fireEvent.click(screen.getByText('Send correction'));
    await screen.findByText('Your message was saved, but the reply has not been confirmed yet.');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(state.submitProducer).toHaveBeenCalledOnce();
    expect(state.writeConversation).toHaveBeenCalledOnce();
    const request = state.submitProducer.mock.calls[0][0].requestId;
    expect(state.bitfield.mock.calls.some(([selector]) => selector?.params?.addressLabel
      === `package::ai-records-producer::result::${request}`)).toBe(true);
  });
  it('renders only the selected room and never mounts personal history', async () => {
    const { rerender } = render(<ChatView surfaceInput={{ subject_ref: 'room:a' }} />);
    expect(screen.getByText('Private room:a')).toBeTruthy();
    expect(state.personal).not.toHaveBeenCalled();
    expect(state.acknowledge).toHaveBeenCalledWith('conversation:room:a', 1);
    rerender(<ChatView surfaceInput={{ subject_ref: 'room:b' }} />);
    expect(screen.queryByText('Private room:a')).toBeNull();
    expect(screen.getByText('Private room:b')).toBeTruthy();
    expect(state.personal).not.toHaveBeenCalled();
  });
  it('opens another private conversation through search without reading personal history', () => {
    state.privateRead.mockReturnValue({
      data: { sessions: [
        { recordId: 'private:first', title: 'First room thread' },
        { recordId: 'private:second', title: 'Second room thread' },
      ], messagesBySession: {
        'private:first': [{ id: 'turn:first', content: 'First private message', sequence: 0 }],
        'private:second': [{ id: 'turn:second', content: 'Second private message', sequence: 0 }],
      }, unreadByConversation: {} },
      loading: false, error: null, reload: state.reload, acknowledge: state.acknowledge,
    });
    render(<ChatView surfaceInput={{ subject_ref: 'room:a' }} />);
    fireEvent.change(screen.getByPlaceholderText('Search conversations'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Second room thread' }));
    expect(screen.getByText('Second private message')).toBeTruthy();
    expect(screen.queryByText('First private message')).toBeNull();
    expect(state.personal).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
    expect(new Set(state.bitfield.mock.calls.map(([input]) => input))).toEqual(new Set([
      'operation-records', 'progression-projections', 'notification-events', 'workflow-action-records',
    ]));
  });

  it('renders personal Chat with an available assistant and optional participant controls', () => {
    const empty: unknown[] = [];
    const profiles = [{ kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Primary profile', instruction_refs: ['instruction:chat'] }];
    state.personal.mockReturnValue({ sessions: [], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles : empty);
    render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary', assistantLabel: 'My assistant' }} />);
    expect(screen.getByRole('button', { name: 'My assistant' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Primary profile/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose participants' })).toBeTruthy();
    expect(state.send).not.toHaveBeenCalled();
  });

  it('loads an older conversation outside the active window and opens it without sending', async () => {
    const empty: unknown[] = [];
    const profiles = [{ kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Primary profile', instruction_refs: ['instruction:chat'] }];
    const window = { rows: [], conversation_page_cursor: { content_hash: `1f:${'a'.repeat(64)}`, offset: 0 }, has_older: true };
    state.personal.mockReturnValue({ sessions: [], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles : input === 'chat-session-window' ? window : empty);
    state.readConversations.mockResolvedValue({ rows: [{
      recordId: 'chat-session:older', sessionId: 'older', title: 'Earlier saved work',
      participantRef: 'assistant:primary', participantRefs: ['assistant:primary'], wayRefs: [], serviceConnectionRefs: [],
      legacySourceAdapterRef: '', projectSlug: '', projectName: null,
      startedAt: '2026-09-01T10:00:00Z', lastActivityAt: '2026-09-01T10:00:00Z', messageCount: 0,
    }], next_cursor: null, has_more: false });
    render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary', assistantLabel: 'My assistant' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older conversations' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Earlier saved work' }));
    expect(await screen.findByRole('button', { name: 'Copy conversation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load older conversations' })).toBeNull();
    expect(state.readConversations).toHaveBeenCalledWith(window.conversation_page_cursor, expect.any(AbortSignal));
    expect(state.send).not.toHaveBeenCalled();
  });

  it('opens a saved personal conversation with its real header and copy confirmation', async () => {
    const empty: unknown[] = [];
    const profiles = [{ kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Primary profile', instruction_refs: ['instruction:chat'] }];
    const session = {
      recordId: 'chat-session:saved', sessionId: 'saved', title: 'Saved personal conversation',
      participantRef: 'assistant:primary', participantRefs: ['assistant:primary'], wayRefs: [], serviceConnectionRefs: [],
      legacySourceAdapterRef: '', projectSlug: '', projectName: null,
      startedAt: '2026-09-12T10:00:00Z', lastActivityAt: '2026-09-12T10:00:00Z', messageCount: 0,
    };
    state.personal.mockReturnValue({ sessions: [session], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles : empty);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary', assistantLabel: 'My assistant' }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Saved personal conversation' }));
      const copy = await screen.findByRole('button', { name: 'Copy conversation' });
      fireEvent.click(copy);
      await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      expect(screen.getByRole('button', { name: 'Copy conversation' })).toBeTruthy();
      expect(state.send).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    }
  });

  it.each([false, true])('distinguishes unknown empty source pages from confirmed empty pages (known=%s)', async known => {
    const empty: unknown[] = [];
    const profiles = [{ kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Primary profile', instruction_refs: ['instruction:chat'] }];
    state.personal.mockReturnValue({ sessions: [{
      recordId: 'chat-session:source', sessionId: 'source', title: 'Source conversation',
      participantRefs: ['assistant:primary'], participantRef: 'assistant:primary', wayRefs: [], serviceConnectionRefs: [],
      filePath: '/source/session.jsonl', legacySourceAdapterRef: '', projectSlug: '', projectName: null,
      startedAt: '2026-09-12T10:00:00Z', lastActivityAt: '2026-09-12T10:00:00Z', messageCount: 14,
    }], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles : empty);
    state.readPage.mockResolvedValue({ lines: [], total_count: known ? 0 : null, total_count_known: known });
    render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Source conversation' }));
    await waitFor(() => expect(state.readPage).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText('Loading the latest transcript messages...')).toBeNull());
    expect(!!screen.queryByText('This conversation could not be loaded. Try opening it again.')).toBe(!known);
    expect(state.send).not.toHaveBeenCalled();
  });

  it('shows a failed source read and clears it when New chat is selected', async () => {
    const empty: unknown[] = [];
    const profiles = [{ kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Primary profile', instruction_refs: ['instruction:chat'] }];
    state.personal.mockReturnValue({ sessions: [{
      recordId: 'chat-session:source', sessionId: 'source', title: 'Source conversation',
      participantRefs: ['assistant:primary'], participantRef: 'assistant:primary', wayRefs: [], serviceConnectionRefs: [],
      filePath: '/source/session.jsonl', legacySourceAdapterRef: '', projectSlug: '', projectName: null,
      startedAt: '2026-09-12T10:00:00Z', lastActivityAt: '2026-09-12T10:00:00Z', messageCount: 14,
    }], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles : empty);
    state.readPage.mockRejectedValue(new Error('Permission denied'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary' }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Source conversation' }));
      await waitFor(() => expect(screen.getAllByText('This conversation could not be loaded. Try opening it again.').length).toBeGreaterThan(0));
      fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
      await waitFor(() => expect(screen.queryByText('This conversation could not be loaded. Try opening it again.')).toBeNull());
      expect(state.send).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('keeps the app assistant name on its default while selecting an explicit handoff', () => {
    const empty: unknown[] = [];
    const profiles = [
      { kind: 'ai-agent-profile', id: 'assistant:primary', label: 'Primary profile', instruction_refs: ['instruction:chat'] },
      { kind: 'ai-agent-profile', id: 'assistant:handoff', label: 'Handoff profile', instruction_refs: ['instruction:handoff'] },
    ];
    state.personal.mockReturnValue({ sessions: [], messagesBySession: {}, loading: false, error: null });
    state.bitfield.mockImplementation(input => input === 'agent-profile-participants' ? profiles : empty);
    render(<ChatView surfaceInput={{ defaultParticipantRef: 'assistant:primary', participantRef: 'assistant:handoff', assistantLabel: 'My assistant' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose participants' }));
    expect(screen.getByRole('button', { name: 'Remove from chat: Handoff profile' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to chat: My assistant' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove from chat: My assistant' })).toBeNull();
    expect(state.send).not.toHaveBeenCalled();
  });

  it('retries an unacknowledged send with the identical turn and effect', async () => {
    state.send.mockRejectedValueOnce(new Error('Acknowledgement lost')).mockResolvedValueOnce({ status: 'accepted' });
    render(<ChatView surfaceInput={{ subject_ref: 'room:a' }} />);
    fireEvent.click(screen.getByText('Send correction'));
    await waitFor(() => expect(screen.getByText('Your message was not acknowledged. Try again.')).toBeTruthy());
    const first = state.send.mock.calls[0][0];
    fireEvent.click(screen.getByText('Send correction'));
    await waitFor(() => expect(state.reload).toHaveBeenCalledOnce());
    expect(state.send.mock.calls[1][0]).toEqual(first);
    expect(first).toMatchObject({ operation: 'append', subject_ref: 'room:a', conversation_ref: 'conversation:room:a', content: 'A correction' });
  });
  it('does not let a delayed old-room failure appear in a new room', async () => {
    let reject!: (error: Error) => void;
    state.send.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const { rerender } = render(<ChatView surfaceInput={{ subject_ref: 'room:a' }} />);
    fireEvent.click(screen.getByText('Send correction'));
    rerender(<ChatView surfaceInput={{ subject_ref: 'room:b' }} />);
    await act(async () => reject(new Error('Old room failure')));
    expect(screen.queryByText('Old room failure')).toBeNull();
    expect(screen.getByText('Private room:b')).toBeTruthy();
  });

  it('records a live correction in Conversations before invoking the exact linked owner transition', async () => {
    state.bitfield.mockImplementation((selector: string) => selector === 'operation-records' ? {
      operations: [{
        id: 'operation:a', ownerPackage: 'operation-records',
        source: { package: 'operation-records', type: 'objective', id: 'objective:a' },
        linkRefs: ['package::conversations::addressed-exchange-conversation::conversation:room:a'],
        dependencyRefs: [], evidenceRefs: ['proof:before'], candidateFactRefs: ['fact:affected'], operationClaimRefs: [],
        agentProfileRefs: [], instructionBlockRefs: [], memoryContextRefs: [], toolDescriptorRefs: [], actionGuardCheckRefs: [],
        budgetReservationRefs: [], executionHistoryRefs: [], relationshipEdgeRefs: [], trainingBatchRefs: [], credentialHandleRefs: [],
        providerHandleRefs: [], serviceConnectionHandleRefs: [], kindDescriptor: 'work', stateDescriptor: 'running', priority: 'normal',
        priorityDescriptor: 'normal', privacyClass: 'private', modeHints: ['active'], sortKey: '2026-09-10T10:00:00Z',
        display: { title: 'Active work', status: 'Running', reason: 'Uses the current objective.', detail: [] },
        transitions: [{ id: 'transition:a:correct', ownerPackage: 'owner', actionDefinitionId: 'action:owner:correct', target: 'slot::workflow',
          label: 'Correct', input: { operation_ref: 'operation:a', expected_owner_revision: 1 }, idempotencyKey: 'idem:a:correct', requiresClaim: false,
          evidenceRefs: ['proof:before'], candidateFactRefs: ['fact:affected'], modeHints: ['correction', 'requires-review-reason'] }],
      }], claims: [],
    } : []);
    render(<ChatView surfaceInput={{ subject_ref: 'room:a' }} />);
    fireEvent.click(screen.getByText('Send correction'));
    await waitFor(() => expect(state.correct).toHaveBeenCalledOnce());
    expect(state.send.mock.invocationCallOrder[0]).toBeLessThan(state.correct.mock.invocationCallOrder[0]);
    expect(state.correct.mock.calls[0][1]).toMatchObject({
      id: 'transition:a:correct', input: {
        operation_ref: 'operation:a',
        review_reason: 'A correction',
        subject_ref: 'room:a',
        conversation_ref: 'conversation:room:a',
        correction_turn_ref: expect.any(String),
        correction_handoff_ref: 'package::conversations::background-work-correction-handoff::turn:test',
      },
    });
    expect(state.send.mock.calls[0][0]).toMatchObject({ correction_request: {
      work_ref: 'operation:a', expected_owner_revision: 1,
    } });
  });
});
