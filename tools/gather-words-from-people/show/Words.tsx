// tools/gather-words-from-people/show/Words.tsx
//
// PURPOSE
//   The page a person opens from the ask for their words: a heading and a few lines, a field for what they say, a choice of
//   what the words may be used for, and a button. After it is sent it says thanks; a link that matches no ask says so. The
//   program checks the link and keeps the words; the screen draws the state it is given and reports what is typed and sent.
//
// NON-NEGOTIABLE INVARIANTS
//   1. View is pure: no fetch and no window while it renders. The host owns the state (`state`, the words typed, the consent
//      chosen, the error, whether a send is under way) and passes it as props; every change is a callback (onSaidChange,
//      onConsentChange, onSubmit).
//   2. Every word drawn is `page` (the gathering's own row); the screen holds none of its own. A heading draws its last word
//      solid, the way a landing's headings are drawn.
//   3. The consents are the gathering's `consents` (id and label), each a choice tile; no consent is chosen for the person,
//      and the button waits for words and a consent.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { SectionShell, TextColumn, Text, StatementText } from '../../ui/show/marketing-page/MarketingPagePrimitives.tsx';
import { Button } from '../../ui/show/button/Button.tsx';
import { ChoiceTiles } from '../../ui/show/choice-tiles/ChoiceTiles.tsx';
import { Container } from '../../ui/show/container/index.ts';
import { Form } from '../../ui/show/form/Form.tsx';
import { Textarea } from '../../ui/show/input/index.ts';

export type WordsPage = {
  heading: string;
  body: string;
  words_label: string;
  words_hint: string;
  consent_legend: string;
  consent_note: string;
  button: string;
  invalid: string;
  thanks: { heading: string; body: string };
  not_found: { heading: string; body: string };
};
export type Consent = { id: string; label: string };
export type WordsState = 'form' | 'thanks' | 'not_found';

export type WordsProps = {
  page: WordsPage;
  consents: readonly Consent[];
  state?: WordsState;
  said?: string;
  consent?: string | null;
  error?: string;
  sending?: boolean;
  onSaidChange?: (said: string) => void;
  onConsentChange?: (consent: string) => void;
  onSubmit?: (said: string, consent: string) => void;
};

// A heading whose last word is drawn solid.
function Heading({ text }: { text: string }) {
  const at = text.lastIndexOf(' ') + 1;
  return <StatementText align="center" lines={[[{ text: text.slice(0, at) }, { text: text.slice(at), solid: true }]]} />;
}

function Ask({ page, consents, said = '', consent = null, error = '', sending = false, onSaidChange, onConsentChange, onSubmit }: WordsProps) {
  const tiles = consents.map(item => ({ id: item.id, label: item.label }));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (consent !== null) onSubmit?.(said, consent);
  };
  return (
    <>
      <Heading text={page.heading} />
      <Text color="muted">{page.body}</Text>
      <Form onSubmit={submit} className="grid w-full gap-4 text-left">
        <Textarea id="words-said" name="words" label={page.words_label} required rows={6} value={said} onChange={event => onSaidChange?.(event.target.value)} />
        <Text color="muted">{page.words_hint}</Text>
        <ChoiceTiles kind="radio" label={page.consent_legend} tiles={tiles} chosen={consent} onPick={tile => onConsentChange?.(tile.id)} />
        <Text color="muted">{page.consent_note}</Text>
        {error === '' ? null : <Text role="alert" weight="bold" color="error">{error}</Text>}
        <Container layout="horizontal">
          <Button type="submit" size="lg" variant="primary" disabled={sending || said.trim() === '' || consent === null}>{page.button}</Button>
        </Container>
      </Form>
    </>
  );
}

export function View(props: WordsProps) {
  const { page, state = 'form' } = props;
  return (
    <SectionShell paddingY="hero" size="narrow">
      <TextColumn align="center" className="gap-4">
        {state === 'not_found' ? (
          <>
            <Heading text={page.not_found.heading} />
            <Text color="muted">{page.not_found.body}</Text>
          </>
        ) : state === 'thanks' ? (
          <>
            <Heading text={page.thanks.heading} />
            <Text color="muted">{page.thanks.body}</Text>
          </>
        ) : <Ask {...props} />}
      </TextColumn>
    </SectionShell>
  );
}
