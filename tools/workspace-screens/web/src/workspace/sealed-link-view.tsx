// src/workspace/sealed-link-view.tsx
//
// PURPOSE
//   Opens a sealed link's record in the browser (once written by src/record-share-pages.mjs, now the Workshop tool tools/write-public-share-files): the page holds one host
//   carrying the share's code and the words; this fetches the sealed copy the store keeps (GET /share/<code>/sealed),
//   opens it with the key and the record id in the link's own fragment, and draws what it holds read-only.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The key never leaves this page: a fragment is not sent to any server, and nothing here posts it anywhere.
//   2. A link without its key, a key that does not open the copy, or a copy the store no longer holds each say so in
//      the words the page carried (record-sharing.json sealed.page_words), never an empty page or a guess.
//   3. Every control and every word is a shared part (parts/ui); this file writes no markup and no appearance.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Card, Container, SchemaValueView, Text } from '../../parts/ui';
import { linkKeyOf, linkRecordOf, openFromLink } from '../../parts/sealed-records/do-work/sealed-records.mjs';

type Words = { reading: string; no_key: string; wrong_key: string; unavailable: string; empty: string };
type Carried = { settings?: { code?: string; words?: Words } };
type Opened = { type: string; value: unknown };
type Line = { label: string; value: unknown };

const present = (value: unknown): boolean => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length);

/** What an opened record holds, one line for each of its fields (a plain value being its own line); each value is shown
 *  through the shared value view (parts/ui SchemaValueView), never as JSON text. */
export function linesOf(opened: Opened): Line[] {
  const value = opened.value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).map(([label, held]) => ({ label, value: held })).filter(line => present(line.value));
  }
  return present(value) ? [{ label: opened.type, value }] : [];
}

type State = { status: 'reading' } | { status: 'failed'; said: string } | { status: 'opened'; lines: Line[] };

async function open(code: string, words: Words): Promise<State> {
  let recordId: string | null;
  try { linkKeyOf(location.href); recordId = linkRecordOf(location.href); } catch { return { status: 'failed', said: words.no_key }; }
  if (!recordId) return { status: 'failed', said: words.no_key };
  const reply = await fetch(`/share/${encodeURIComponent(code)}/sealed`, { headers: { accept: 'application/json' }, cache: 'no-store' }).catch(() => null);
  if (!reply?.ok) return { status: 'failed', said: words.unavailable };
  const held = await reply.json() as { content_id: string; value: unknown };
  try {
    const lines = linesOf(await openFromLink(location.href, recordId, { content_id: held.content_id, value: held.value }) as Opened);
    return { status: 'opened', lines };
  } catch { return { status: 'failed', said: words.wrong_key }; }
}

function SealedLink({ code, words }: { code: string; words: Words }) {
  const [state, setState] = React.useState<State>({ status: 'reading' });
  React.useEffect(() => { void open(code, words).then(setState); }, [code, words]);
  if (state.status === 'reading') return <Text variant="body-xs">{words.reading}</Text>;
  if (state.status === 'failed') return <Text variant="body-xs">{state.said}</Text>;
  if (!state.lines.length) return <Text variant="body-xs">{words.empty}</Text>;
  return <Card variant="surface" padding="lg">
    <Container layout="vertical" gap="md">
      {state.lines.map(line => <Container key={line.label} layout="vertical" gap="xs">
        <Text variant="heading-xs">{line.label}</Text>
        <SchemaValueView value={line.value} />
      </Container>)}
    </Container>
  </Card>;
}

/** Opens every sealed link host the page carries. */
export function drawSealedLinks() {
  for (const host of document.querySelectorAll<HTMLElement>('[data-list-view="sealed-link"]')) {
    const script = host.querySelector<HTMLScriptElement>(':scope > script.page-view-data');
    let carried: Carried | null = null;
    try { carried = script ? JSON.parse(script.textContent ?? '') as Carried : null; } catch { carried = null; }
    const code = carried?.settings?.code;
    const words = carried?.settings?.words;
    if (code && words) createRoot(host).render(<SealedLink code={code} words={words} />);
  }
}
