// extension/src/save-chat.tsx
//
// PURPOSE
//   Save this chat: on a page with one conversation open on a chat site that has a row in
//   extension/conversation-sites.json (ChatGPT, Gemini, WhatsApp), the popup offers to keep that conversation in the
//   person's own Trillion, word for word. Pressing it reads the open conversation in this tab (read-conversation.mjs)
//   and hands it to the account's bring_in_chat tool, the same road a chat export takes, so the messages land with the
//   person's other conversations and saving again adds only what is new.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is read or sent until the person presses the button, and only the conversation open in this tab.
//   2. Built from the shared parts (tools/ui); words from extension/words.json (save_chat) and the site's row (hint).
//   3. "Saved" is shown only after the account answered; its refusal is said as it was said.
//   4. While the page is being read (older messages included, where the site's row says to read them), how many
//      messages have been read so far is shown, read from the tab under read-conversation.mjs's progressKey.

import React from 'react';
import { Button } from 'trillion-workshop/tools/ui/show/button/index.ts';
import { Container } from 'trillion-workshop/tools/ui/show/container/index.ts';
import { NamedIcon } from 'trillion-workshop/tools/ui/show/icon/index.ts';
import { Text } from 'trillion-workshop/tools/ui/show/text/index.ts';
import { progressKey, readConversation, siteFor } from './read-conversation.mjs';
import { SignInNeeded, signedInAccount, tool } from './trillion.mjs';
import sites from '../conversation-sites.json' with { type: 'json' };
import words from '../words.json' with { type: 'json' };

type Site = (typeof sites.sites)[number];
type Read = { app: string; conversation_id?: string; title?: string | null; messages?: unknown[]; problem?: string };
type Kept = { messages: number; added: number; already_there: number };

/** The Save this chat control for the tab the popup was opened on, or nothing when no site row reads that page. */
export function SaveThisChat({ tabId, url, onSignInNeeded }: { tabId: number | null; url: string | null | undefined; onSignInNeeded: () => void }) {
  const site = React.useMemo(() => (url ? siteFor(url, sites.sites) as Site | null : null), [url]);
  const [phase, setPhase] = React.useState<'ready' | 'reading' | 'saving' | 'saved'>('ready');
  const [readSoFar, setReadSoFar] = React.useState(0);
  const [kept, setKept] = React.useState<Kept | null>(null);
  // While the page is read, how many messages it has read so far.
  React.useEffect(() => {
    if (phase !== 'reading' || tabId === null) return;
    const timer = setInterval(async () => {
      const [answer] = await chrome.scripting.executeScript({ target: { tabId }, func: (key: string) => (globalThis as unknown as Record<string, { messages?: number } | undefined>)[key]?.messages ?? 0, args: [progressKey] }).catch(() => []);
      if (typeof answer?.result === 'number') setReadSoFar(answer.result);
    }, 400);
    return () => clearInterval(timer);
  }, [phase, tabId]);
  const [problem, setProblem] = React.useState<string | null>(null);
  if (!site || tabId === null) return null;
  const said = words.save_chat;

  async function save() {
    setPhase('reading'); setReadSoFar(0); setProblem(null); setKept(null);
    try {
      const account = await signedInAccount();
      if (!account) throw new SignInNeeded();
      const read = (await chrome.scripting.executeScript({ target: { tabId: tabId! }, func: readConversation, args: [site, progressKey] }))[0]?.result as Read | undefined;
      if (!read || read.problem) {
        throw new Error((said.problems as Record<string, string>)[read?.problem ?? 'unreadable'] ?? said.problems.unreadable);
      }
      const { app, ...conversation } = read;
      setReadSoFar(conversation.messages?.length ?? 0);
      setPhase('saving');
      const saved = await tool('bring_in_chat', { conversation, app }, account);
      if (await signedInAccount() !== account) throw new SignInNeeded();
      setKept(saved);
      setPhase('saved');
    } catch (error) {
      setPhase('ready');
      if (error instanceof SignInNeeded) {
        if (!await signedInAccount()) onSignInNeeded();
        throw error;
      }
      setProblem(`${said.could_not_save} ${(error as Error).message}`);
      throw error;
    }
  }

  return (
    <Container layout="vertical" gap="xs" padding="sm" rounded="lg" border="all" width="full">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" width="full">
        <Container layout="horizontal" gap="sm" alignItems="center" className="min-w-0 flex-1">
          <NamedIcon name={phase === 'saved' ? 'Check' : 'MessagesSquare'} size="sm" aria-hidden="true" />
          <Text variant="body-xs" weight="medium" truncate>
            {phase === 'saved' && kept ? said.saved.replace('{app}', site.app) : said.heading.replace('{app}', site.app)}
          </Text>
        </Container>
        {phase === 'saved' ? null : (
          <Button variant="secondary" size="sm" loading={phase !== 'ready'} onClick={save}>
            {phase === 'ready' ? said.save : said.saving}
          </Button>
        )}
      </Container>
      <Text variant="caption" color={problem ? 'error' : 'muted'}>
        {problem
          ?? (phase === 'reading' ? (readSoFar ? said.reading_count.replace('{count}', String(readSoFar)) : said.reading)
          : phase === 'saving' ? said.saving_count.replace('{count}', String(readSoFar))
          : phase === 'saved' && kept
            ? (kept.added === 1 ? said.saved_detail_one : kept.added ? said.saved_detail.replace('{added}', String(kept.added)) : said.nothing_new)
            : ('hint' in site && site.hint) || said.detail)}
      </Text>
    </Container>
  );
}
