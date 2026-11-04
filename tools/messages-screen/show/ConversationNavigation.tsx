// PORTED FROM: bitfield-packages/packages/chat/show/ConversationNavigation.tsx @ e99ac5976
import { useMemo, useState } from 'react';
import { Button, Container, Text } from '../../ui';
import { AppSidebar } from '../../sidebar/show/AppSidebar';
import type { NavSectionData } from '../../sidebar/show/SidebarContent';
import { DisplayMark } from '../../ui/show/display-mark';
import { participantToMarkSpec, type ParticipantMarkSource } from './participant-mark-spec';

export interface ConversationNavigationProps {
  instanceId: string;
  sessions: readonly { recordId: string; title?: string | null; participantRefs?: readonly string[]; lastMessagePreview?: string | null }[];
  /** Who each conversation is with: a row leads with its first participant's mark and its hover card reads its latest words. */
  participantMarks?: readonly ParticipantMarkSource[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onNewChat?: () => void;
  historyUnavailable?: boolean;
  onRetryHistory?: () => Promise<unknown>;
  hasOlderConversations?: boolean;
  loadingOlderConversations?: boolean;
  olderConversationsError?: boolean;
  onLoadOlderConversations?: () => Promise<void>;
  primaryAssistant?: { id: string; label: string };
  participants?: readonly { id: string; label: string; kind: 'people' | 'agents' }[];
  onSelectParticipant?: (id: string) => void;
  sectionKinds?: readonly string[];
  /** Embedding owners can supply additional authorized lists. */
  sections?: NavSectionData[];
  onNavigate?: (id: string) => void;
}

/** Chat supplies authorized rows and callbacks; the sidebar owns navigation UI. */
export function ConversationNavigation({ instanceId, sessions, selectedId, onSelect, onNewChat,
  historyUnavailable, onRetryHistory, primaryAssistant, participants = [], participantMarks = [], onSelectParticipant, sectionKinds = ['conversations', 'people', 'agents'], sections = [], onNavigate,
  hasOlderConversations, loadingOlderConversations, olderConversationsError, onLoadOlderConversations,
}: ConversationNavigationProps) {
  const [search, setSearch] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const navigation = useMemo(() => {
    const rows: NavSectionData[] = sectionKinds.includes('conversations') ? [{ id: 'conversations', title: 'Conversations', items: sessions.map(session => {
      const mark = participantMarks.find(participant => participant.participantRef === session.participantRefs?.[0]);
      return {
        id: `conversation:${session.recordId}`, label: session.title?.trim() || 'Untitled conversation', icon: 'MessageSquare',
        ...(mark ? { leading: <DisplayMark spec={participantToMarkSpec(mark)} size="xs" /> } : {}),
        ...(session.lastMessagePreview?.trim() ? { description: session.lastMessagePreview.trim() } : {}),
      };
    }) }] : [];
    for (const kind of ['people', 'agents'] as const) {
      const items = participants.filter(person => person.kind === kind && person.id !== primaryAssistant?.id)
        .map(person => ({ id: `participant:${person.id}`, label: person.label, icon: kind === 'people' ? 'User' : 'Bot' }));
      if (sectionKinds.includes(kind) && items.length && onSelectParticipant) rows.push({ id: kind, title: kind === 'people' ? 'People' : 'Other agents',
        items, collapsible: true, defaultCollapsed: true });
    }
    const query = search.trim().toLocaleLowerCase();
    const filter = (section: NavSectionData): NavSectionData => ({ ...section,
      items: section.items.filter(item => item.label.toLocaleLowerCase().includes(query)),
      sections: section.sections?.map(filter),
    });
    return [...rows, ...sections].map(filter);
  }, [sessions, participants, participantMarks, primaryAssistant?.id, onSelectParticipant, sectionKinds, sections, search]);
  return <Container layout="vertical" minHeight="0" overflow="hidden" style={{ width: 240, flexShrink: 0 }} className="chat-panes-list">
    <AppSidebar presentation="embedded" instanceId={instanceId} sections={navigation}
      currentSelectionId={selectedId ? `conversation:${selectedId}` : ''}
      onNavigate={id => {
        const session = sessions.find(row => `conversation:${row.recordId}` === id);
        if (session) onSelect(session.recordId);
        else if (id === 'primary-assistant' && primaryAssistant) onSelectParticipant?.(primaryAssistant.id);
        else {
          const participant = participants.find(row => `participant:${row.id}` === id);
          if (participant) onSelectParticipant?.(participant.id);
          else onNavigate?.(id);
        }
      }}
      headerItems={primaryAssistant ? [{ id: 'primary-assistant', label: primaryAssistant.label, icon: 'MessageSquare' }] : []}
      headerContent={<>
        {onNewChat && <Button variant="ghost" size="sm" onClick={onNewChat}>New chat</Button>}
        {sectionKinds.includes('conversations') && <>
          {olderConversationsError && <Text variant="caption" role="status">Older conversations could not be loaded.</Text>}
          {hasOlderConversations && onLoadOlderConversations && <Button variant="ghost" size="sm"
            disabled={loadingOlderConversations} onClick={() => onLoadOlderConversations()}>
            {loadingOlderConversations ? 'Loading conversations…' : olderConversationsError ? 'Retry older conversations' : 'Load older conversations'}
          </Button>}
        </>}
        {(historyUnavailable || retryFailed) && <Container padding="sm" role="status">
          <Text variant="caption">Some conversations could not be loaded.</Text>
          {onRetryHistory && <Button variant="ghost" size="sm" disabled={retrying} onClick={async () => {
            setRetrying(true); setRetryFailed(false);
            try { await onRetryHistory(); } catch { setRetryFailed(true); } finally { setRetrying(false); }
          }}>{retrying ? 'Retrying…' : 'Retry conversations'}</Button>}
        </Container>}
      </>}
      searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search conversations" searchAriaLabel="Search conversations"
      emptyContent={<Text variant="caption">{search ? 'No matching conversations' : 'No conversations yet'}</Text>} />
  </Container>;
}
