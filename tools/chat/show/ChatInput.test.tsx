// PORTED FROM: bitfield-packages/packages/chat/show/ChatInput.test.tsx @ e99ac5976
// ChatInput composer — rebuild smoke + behavior tests (#60).
// Verifies the ui/-primitive composer renders, gates send, sends on Enter, and
// surfaces the active-preset row. (Auto-grow height math is a Textarea-primitive
// concern; jsdom has no layout so it is not asserted here.)
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ChatInput, useChatDraftAuthority } from './ChatInput';
import { ChatComposer } from './input/chat-composer';

afterEach(cleanup);

describe('ChatInput composer', () => {
  it('does not restore private text after an unobserved authority cycle while unmounted', () => {
    function Room({ authority }: { authority: string }) {
      useChatDraftAuthority('room:unmounted-cycle', authority);
      return <ChatInput draftScope={JSON.stringify(['private', authority, 'room:unmounted-cycle', 'conversation'])} onSend={() => false} />;
    }
    let authority = 'authority:A';
    const first = render(<Room authority={authority} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'must not resurface' } });
    first.unmount();
    // No ChatView is mounted to receive these outside-session changes.
    authority = 'authority:B';
    authority = 'authority:A';
    render(<Room authority={authority} />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
  });
  it('forgets private room drafts when its authority disappears or changes', () => {
    function Room({ authority }: { authority: string }) {
      useChatDraftAuthority('room:draft-auth', authority);
      return <ChatInput draftScope={authority ? JSON.stringify(['private', authority, 'room:draft-auth', 'conversation']) : undefined} onSend={() => false} />;
    }
    const view = render(<Room authority="authority:one" />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'private original' } });
    view.rerender(<Room authority="" />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
    view.rerender(<Room authority="authority:one" />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'new private draft' } });
    view.rerender(<Room authority="authority:two" />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
    view.rerender(<Room authority="authority:one" />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
  });
  it('preserves an active-conversation composer draft through a real remount', () => {
    const scope = 'personal/profile-active/conversation-active';
    const first = render(<ChatComposer draftScope={scope} onSend={() => false} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'active conversation draft' } });
    first.unmount();
    render(<ChatComposer draftScope={scope} onSend={() => false} />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('active conversation draft');
  });
  it('restores exact unsent text after unmount and isolates other profile/conversation scopes', () => {
    const onSend = vi.fn();
    const scope = 'personal/profile-a/conversation-remount';
    const first = render(<ChatInput draftScope={scope} onSend={onSend} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '  unfinished\ntext  ' } });
    first.unmount();
    const other = render(<ChatInput draftScope="private/authority-b/conversation-remount" onSend={onSend} />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
    other.unmount();
    render(<ChatInput draftScope={scope} onSend={onSend} />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('  unfinished\ntext  ');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('retains rejected sends across remount and clears an accepted send', async () => {
    const scope = 'personal/profile-a/rejected-draft';
    const first = render(<ChatInput draftScope={scope} onSend={() => false} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'unsent' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await screen.findByText('Your message could not be sent. Try again.');
    first.unmount();
    const second = render(<ChatInput draftScope={scope} onSend={() => true} />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('unsent');
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe(''));
    second.unmount();
    render(<ChatInput draftScope={scope} onSend={() => true} />);
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
  });

  it('does not erase a successor draft when an old unmounted send completes', async () => {
    let accept!: (value: boolean) => void;
    const scope = 'personal/profile-a/pending-draft';
    const first = render(<ChatInput draftScope={scope} onSend={() => new Promise<boolean>(resolve => { accept = resolve; })} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'original' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    first.unmount();
    render(<ChatInput draftScope={scope} onSend={() => true} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'newer draft' } });
    await act(async () => { accept(true); });
    await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('newer draft'));
  });
  it('renders the message field and a send button', () => {
    render(<ChatInput onSend={() => {}} />);
    expect(screen.getByLabelText('Message')).toBeTruthy();
    expect(screen.getByLabelText('Send message')).toBeTruthy();
  });

  it('send is disabled while empty and enables once text is typed', () => {
    render(<ChatInput onSend={() => {}} />);
    const send = screen.getByLabelText('Send message') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi coach' } });
    expect(send.disabled).toBe(false);
  });

  it('Enter sends the trimmed value (Shift+Enter does not)', () => {
    const onSend = vi.fn(() => true);
    render(<ChatInput onSend={onSend} />);
    const field = screen.getByLabelText('Message');
    fireEvent.change(field, { target: { value: '  hello  ' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('renders the active-preset row and fires dismiss', () => {
    const onPresetDismiss = vi.fn();
    render(
      <ChatInput
        onSend={() => {}}
        activePreset={{ label: 'Refactor', prompt: '...', description: 'tighten the code' }}
        onPresetDismiss={onPresetDismiss}
      />,
    );
    expect(screen.getByText('Refactor')).toBeTruthy();
    expect(screen.getByText('tighten the code')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Dismiss preset'));
    expect(onPresetDismiss).toHaveBeenCalled();
  });

  it('renders caller-supplied affordance controls (footer)', () => {
    render(<ChatInput onSend={() => {}} footer={<span>participant-pill</span>} />);
    expect(screen.getByText('participant-pill')).toBeTruthy();
  });

  it('renders the attached-context chip and fires dismiss', () => {
    const onSelectedContextDismiss = vi.fn();
    render(
      <ChatInput
        onSend={() => {}}
        selectedContext={{ label: 'Selected text', excerpt: 'the glaze drips late' }}
        onSelectedContextDismiss={onSelectedContextDismiss}
      />,
    );
    expect(screen.getByText('Selected text')).toBeTruthy();
    expect(screen.getByText('the glaze drips late')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove attached context'));
    expect(onSelectedContextDismiss).toHaveBeenCalled();
  });

  it('while streaming: shows Stop (not Send) and fires onStop', () => {
    const onStop = vi.fn();
    render(<ChatInput onSend={() => {}} isStreaming onStop={onStop} value="busy" onValueChange={() => {}} />);
    expect(screen.queryByLabelText('Send message')).toBeNull();
    fireEvent.click(screen.getByLabelText('Stop response'));
    expect(onStop).toHaveBeenCalled();
  });

  it('controlled mode: edits flow through onValueChange (parent owns the text)', () => {
    const onValueChange = vi.fn();
    render(<ChatInput onSend={() => {}} value="" onValueChange={onValueChange} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '/plan' } });
    expect(onValueChange).toHaveBeenCalledWith('/plan');
  });

  it('acknowledges an in-flight send immediately and prevents double dispatch', async () => {
    let settle!: (accepted: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    render(<ChatInput onSend={onSend} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(screen.getByRole('status').textContent).toBe('Sending…');
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledTimes(1);
    settle(true);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('turns a rejected dispatch into an explicit retryable error and preserves intent', async () => {
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<ChatInput onSend={onSend} />);
    const field = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'keep this exact intent' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Your message could not be sent. Try again.');
    expect(field.value).toBe('keep this exact intent');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenLastCalledWith('keep this exact intent');
  });
});
