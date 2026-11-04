import * as React from 'react';
import { Button, Container, Input, NamedIcon, Switch, Text, Textarea } from '../../ui';
import settings from '../read-data/meeting-settings.json';
import { cleanWord } from '../read-data/meeting-settings.mjs';

export type AiInstructionsValue = { text: string; scopes: string[]; words: string[] };
export type AiInstructionsChange = { instructionText?: string; instructionScopes?: string[]; words?: string[] };

/** The words the speech model should spell right: chips to remove, one box where Enter adds the typed word. */
function CustomWords({ words, onChange }: { words: string[]; onChange: (words: string[]) => void }) {
  const copy = settings.words;
  const [draft, setDraft] = React.useState('');
  const add = () => {
    const word = cleanWord(draft);
    if (!word) return;
    if (!words.some(item => item.toLowerCase() === word.toLowerCase()) && words.length < settings.limits.words_count) onChange([...words, word]);
    setDraft('');
  };
  return (
    <Container layout="vertical" gap="xs" minWidth="0">
      <Text variant="heading">{copy.title}</Text>
      <Text variant="body-xs" color="faint">{copy.description}</Text>
      <Input aria-label={copy.label} placeholder={copy.placeholder} value={draft} maxLength={settings.limits.word_chars}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
      {words.length === 0 ? <Text variant="body-xs" color="faint" role="status">{copy.none}</Text> : (
        <Container layout="horizontal" gap="xs" wrap minWidth="0">
          {words.map(word => (
            <Button key={word} type="button" variant="outline" size="xs" aria-label={copy.remove.replace('{word}', word)}
              onClick={() => onChange(words.filter(item => item !== word))}>
              {word}<NamedIcon name="x" size="xs" aria-hidden />
            </Button>
          ))}
        </Container>
      )}
    </Container>
  );
}

export function AiInstructionsSettings({ value, onChange }: { value: AiInstructionsValue; onChange: (change: AiInstructionsChange) => void }) {
  const copy = settings.instructions;
  const [text, setText] = React.useState(value.text);
  // The saved text replaces what is typed only when it changed somewhere else, so typing is never overwritten.
  const lastSaved = React.useRef(value.text);
  React.useEffect(() => {
    if (value.text !== lastSaved.current) { lastSaved.current = value.text; setText(value.text); }
  }, [value.text]);
  const keep = React.useCallback(() => {
    if (text !== lastSaved.current) { lastSaved.current = text; onChange({ instructionText: text }); }
  }, [text, onChange]);
  // Typing is kept shortly after it pauses, and at once when the box loses focus.
  React.useEffect(() => {
    const timer = setTimeout(keep, settings.save_after_ms);
    return () => clearTimeout(timer);
  }, [keep]);
  return (
    <Container layout="vertical" gap="md" padding="md" minWidth="0">
      <Container layout="vertical" gap="xs" minWidth="0">
        <Text variant="heading">{copy.title}</Text>
        <Text variant="body" color="subtle">{copy.description}</Text>
        <Textarea aria-label={copy.label} placeholder={copy.placeholder} value={text} maxLength={settings.limits.instructions_chars}
          onChange={event => setText(event.target.value)} onBlur={keep} />
        <Text variant="body-xs" color="faint">{copy.counter.replace('{count}', String(text.length)).replace('{max}', String(settings.limits.instructions_chars))}</Text>
      </Container>
      <Container layout="vertical" gap="xs" minWidth="0">
        <Text variant="body-xs" color="faint">{copy.scopes_title}</Text>
        {copy.scopes.map(scope => (
          <Container key={scope.id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" minWidth="0">
            <Text variant="body">{scope.label}</Text>
            <Switch size="md" label={scope.label} checked={value.scopes.includes(scope.id)}
              onCheckedChange={checked => onChange({ instructionScopes: checked ? [...value.scopes, scope.id] : value.scopes.filter(id => id !== scope.id) })} />
          </Container>
        ))}
      </Container>
      <CustomWords words={value.words} onChange={words => onChange({ words })} />
    </Container>
  );
}
