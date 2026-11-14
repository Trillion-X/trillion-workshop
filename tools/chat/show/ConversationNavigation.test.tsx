// PORTED FROM: bitfield-packages/packages/chat/show/ConversationNavigation.test.tsx @ e99ac5976
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationNavigation } from './ConversationNavigation';

afterEach(cleanup);

describe('conversation navigation through the shared sidebar', () => {
  it('offers older conversation loading and preserves saved rows when a page fails', () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<ConversationNavigation instanceId="paging" sessions={[{ recordId: 'kept', title: 'Saved work' }]}
      onSelect={vi.fn()} hasOlderConversations onLoadOlderConversations={load} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older conversations' }));
    expect(load).toHaveBeenCalledOnce();
    rerender(<ConversationNavigation instanceId="paging" sessions={[{ recordId: 'kept', title: 'Saved work' }]}
      onSelect={vi.fn()} hasOlderConversations olderConversationsError onLoadOlderConversations={load} />);
    expect(screen.getByRole('button', { name: 'Saved work' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry older conversations' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Older conversations could not be loaded.');
  });
  it('searches and opens a stored conversation', () => {
    const onSelect = vi.fn();
    render(<ConversationNavigation instanceId="test" sessions={[
      { recordId: 'first', title: 'Pottery practice' },
      { recordId: 'second', title: 'Video ideas' },
    ]} onSelect={onSelect} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search conversations'), { target: { value: 'pottery' } });
    expect(screen.queryByText('Video ideas')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pottery practice' }));
    expect(onSelect).toHaveBeenCalledWith('first');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps new chat local and only offers caller-supplied conversations', () => {
    const onNewChat = vi.fn();
    render(<ConversationNavigation instanceId="test" sessions={[]} onSelect={vi.fn()} onNewChat={onNewChat} />);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(screen.getByText('No conversations yet')).toBeTruthy();
  });

  it('shows the primary assistant while keeping other agents optional', () => {
    const select = vi.fn();
    render(<ConversationNavigation instanceId="test" sessions={[]} onSelect={vi.fn()}
      primaryAssistant={{ id: 'primary', label: 'My assistant' }}
      participants={[{ id: 'primary', label: 'Primary profile', kind: 'agents' }, { id: 'editor', label: 'Editor', kind: 'agents' }]}
      onSelectParticipant={select} />);
    fireEvent.click(screen.getByRole('button', { name: 'My assistant' }));
    expect(select).toHaveBeenLastCalledWith('primary');
    expect(screen.queryByRole('button', { name: 'Editor' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Other agents/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Editor' }));
    expect(select).toHaveBeenLastCalledWith('editor');
  });

  it('keeps known conversations accessible when a source fails and allows retry', async () => {
    const retry = vi.fn().mockRejectedValue(new Error('Source unavailable'));
    const select = vi.fn();
    render(<ConversationNavigation instanceId="test" sessions={[{recordId:'kept',title:'Saved conversation'}]}
      onSelect={select} historyUnavailable onRetryHistory={retry} />);
    expect(screen.getByRole('status').textContent).toContain('Some conversations could not be loaded.');
    fireEvent.click(screen.getByRole('button', {name:'Saved conversation'}));
    expect(select).toHaveBeenCalledWith('kept');
    fireEvent.click(screen.getByRole('button', {name:'Retry conversations'}));
    await waitFor(() => expect(screen.getByRole('button', {name:'Retry conversations'}).hasAttribute('disabled')).toBe(false));
    expect(retry).toHaveBeenCalledOnce();
  });
});
