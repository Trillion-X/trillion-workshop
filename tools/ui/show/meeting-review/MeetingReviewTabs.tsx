import React from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs';
import { Text } from '../text';

export type MeetingReviewTab = {
  id: string;
  label: string;
  kind?: string;
  content?: "notes" | "transcript";
  unreadable?: string;
  empty?: string;
  /** A saved, completed review whose result contains no items. */
  completed_empty?: string;
  refresh?: string;
  failed?: string;
  management_action?: string;
  manage?: string;
  review_action?: boolean;
};

export type MeetingReviewTabsProps = {
  tabs: readonly MeetingReviewTab[];
  loadingLabel: string;
  ariaLabel: string;
  notes: React.ReactNode;
  transcript: React.ReactNode;
  results: Readonly<Record<string, string>> | null;
  reviewAction?: React.ReactNode;
  /** The note's heading and facts (title, Created, Meeting, Audio), drawn above the tabs; nothing when not given. */
  header?: React.ReactNode;
  /** What the recording is going through now (its processing steps), drawn above the tabs; nothing when not given. */
  progress?: React.ReactNode;
  error: string;
  reading: boolean;
  onRefresh: () => void;
  onManage: (tabId: string) => void;
  /** Replaces a tab's saved words with its own view of them (e.g. action items by speaker); undefined keeps the words. */
  renderBody?: (tabId: string) => React.ReactNode | undefined;
  /** Tools shown under a tab's words (choices before a re-run, copy, export). */
  renderTools?: (tabId: string) => React.ReactNode;
};

/** Shared tab behavior for a recording's notes, saved results, and transcript. Copy and result kinds come from DATA. */
export function MeetingReviewTabs({ tabs, loadingLabel, ariaLabel, notes, transcript, results, reviewAction, header, progress, error, reading, onRefresh, onManage, renderBody, renderTools }: MeetingReviewTabsProps) {
  const [active, setActive] = React.useState(tabs[0]?.id ?? '');
  return (
    <Container layout="vertical" gap="md" minWidth="0" aria-label={ariaLabel}>
      {header}
      {progress}
      <Tabs value={active} onValueChange={setActive}>
        <TabsList className="flex-wrap">
          {tabs.map(tab => <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>)}
        </TabsList>
        {tabs.map(tab => (
          <TabsContent key={tab.id} value={tab.id} keepMounted={Boolean(tab.content)}>
            {tab.content === 'notes' ? notes : tab.content === 'transcript' ? transcript : (
              <Container layout="vertical" gap="sm" minWidth="0" className="py-3">
                {error ? <Text variant="body" color="subtle" role="alert">{tab.failed ?? error}{tab.failed ? ` ${error}` : ''}</Text> : null}
                {results?.[tab.id] ? (renderBody?.(tab.id) ?? <Text variant="body" wrap="preserve">{results[tab.id]}</Text>)
                  : !error ? <Text variant="body" color="subtle">{results === null ? loadingLabel : tab.empty}</Text> : null}
                {renderTools?.(tab.id)}
                {tab.review_action ? reviewAction : null}
                <Button variant="ghost" size="sm" disabled={reading} onClick={onRefresh}>
                  {reading ? loadingLabel : tab.refresh}
                </Button>
                {tab.manage
                  ? <Button variant="ghost" size="sm" onClick={() => onManage(tab.id)}>{tab.manage}</Button> : null}
              </Container>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </Container>
  );
}
