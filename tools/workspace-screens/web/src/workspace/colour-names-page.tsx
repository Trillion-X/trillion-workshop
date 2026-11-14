// src/workspace/colour-names-page.tsx
//
// PURPOSE
//   The Colour names page of Settings (F-0993): each colour the person's calendars offer, with a name field. A name is
//   kept as the person leaves the field and shows wherever an event's colour is picked (shared-calendar-screen.tsx);
//   Back to the usual name takes it away.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The colours are what the calendar read answers (/work/api/calendar `sources[].event_colors`), once each; a read that
//      is going, a read that failed (with a retry) and no colours are three different pages.
//   2. Every control is a shared part (parts/ui); this file writes no markup of its own and every word is DATA
//      (colour-names.json). The provider's own label is the placeholder, so a colour is never shown by its code alone.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import * as React from 'react';
import { useWorkspacePreference, writeWorkspacePreference } from '#workspace-records';
import { Button, ColorDot, Container, Input, Text } from '../../parts/ui';
import { notify } from '../../parts/ui/show/coss/notifications';
import { readJson } from './api';
import { COLOUR_NAMES, coloursOf, readColourNames, renameColour } from './colour-names.mjs';

type Colour = { color: string; label: string };
const words = COLOUR_NAMES.words;

function NameField({ colour, names }: { colour: Colour; names: Record<string, string> }) {
  const kept = names[colour.color] ?? '';
  const [draft, setDraft] = React.useState(kept);
  React.useEffect(() => setDraft(kept), [kept]);
  const save = (name: string) => {
    if (name.trim() === kept) return;
    writeWorkspacePreference(COLOUR_NAMES.record_key, renameColour(names, colour.color, name)).catch(() => notify(words.unsaved, { kind: 'error' }));
  };
  return (
    <Container layout="horizontal" gap="sm" alignItems="center" data-colour-name="">
      <ColorDot color={colour.color} size="lg" label={colour.label} />
      <Input aria-label={words.name_label} placeholder={colour.label} value={draft} maxLength={COLOUR_NAMES.most_name_chars}
        onChange={event => setDraft(event.target.value)} onBlur={() => save(draft)} />
      {kept ? <Button variant="ghost" size="sm" onClick={() => save('')}>{words.reset}</Button> : null}
    </Container>
  );
}

export function ColourNamesPage() {
  const names = readColourNames(useWorkspacePreference(COLOUR_NAMES.record_key));
  const [colours, setColours] = React.useState<Colour[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    setFailed(false);
    const from = new Date(), to = new Date(from.getTime() + COLOUR_NAMES.read_days * 86_400_000);
    readJson<unknown>(`/work/api/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .then(answer => { if (live) setColours(coloursOf(answer)); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt]);
  return (
    <Container layout="vertical" gap="md" padding="lg" data-settings-page="colour-names">
      <Text as="h1" variant="heading-lg" className="page-title m-0">{words.title}</Text>
      <Text as="p" variant="body" color="secondary">{words.body}</Text>
      {failed ? (
        <Container layout="vertical" gap="sm" data-colour-names-state="failed">
          <Text as="p" variant="body" color="secondary">{words.failed}</Text>
          <Container layout="horizontal"><Button variant="ghost" onClick={() => setAttempt(count => count + 1)}>{words.retry}</Button></Container>
        </Container>
      ) : !colours ? <Text as="p" variant="body" color="secondary" data-colour-names-state="loading">{words.loading}</Text>
        : colours.length === 0 ? <Text as="p" variant="body" color="secondary" data-colour-names-state="empty">{words.empty}</Text>
          : colours.map(colour => <NameField key={colour.color} colour={colour} names={names} />)}
    </Container>
  );
}
