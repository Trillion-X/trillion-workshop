import * as React from 'react';
import { Button, ChoiceTiles, Container, NamedIcon, Switch, Text } from '../../ui';
import { SearchField } from '../../ui/show/search-field/SearchField';
import settings from '../read-data/meeting-settings.json';

export type MeetingNotesValue = {
  sendNotesTo: string;
  smartPages: boolean;
  adhocEvents: boolean;
  languages: string[];
};
export type MeetingNotesChange = Partial<MeetingNotesValue>;

const toggleValue = (value: MeetingNotesValue, id: string) => (id === 'smart_pages' ? value.smartPages : value.adhocEvents);
const toggleChange = (id: string, checked: boolean): MeetingNotesChange => (id === 'smart_pages' ? { smartPages: checked } : { adhocEvents: checked });

/** The chosen languages as removable chips, then a search box over every language not yet chosen. */
function LanguageChooser({ chosen, onChange }: { chosen: string[]; onChange: (languages: string[]) => void }) {
  const copy = settings.languages;
  const [query, setQuery] = React.useState('');
  const labelOf = (id: string) => copy.options.find(option => option.id === id)?.label ?? id;
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? copy.options.filter(option => !chosen.includes(option.id) && option.label.toLowerCase().includes(needle)).slice(0, 8)
    : [];
  const full = chosen.length >= settings.limits.languages_count;
  return (
    <Container layout="vertical" gap="xs" minWidth="0">
      <Text variant="heading">{copy.title}</Text>
      <Text variant="body-xs" color="faint">{copy.description}</Text>
      {chosen.length === 0 ? <Text variant="body-xs" color="faint" role="status">{copy.none_chosen}</Text> : (
        <Container layout="horizontal" gap="xs" wrap minWidth="0">
          {chosen.map(id => (
            <Button key={id} type="button" variant="outline" size="xs"
              aria-label={copy.remove.replace('{language}', labelOf(id))}
              onClick={() => onChange(chosen.filter(item => item !== id))}>
              {labelOf(id)}<NamedIcon name="x" size="xs" aria-hidden />
            </Button>
          ))}
        </Container>
      )}
      {full ? null : <SearchField label={copy.search_label} placeholder={copy.placeholder} value={query}
        onChange={event => setQuery(event.target.value)} />}
      {needle && matches.length === 0 ? <Text variant="body-xs" color="faint" role="status">{copy.none_found}</Text> : null}
      {matches.map(option => (
        <Button key={option.id} type="button" variant="ghost" size="sm"
          onClick={() => { onChange([...chosen, option.id]); setQuery(''); }}>{option.label}</Button>
      ))}
    </Container>
  );
}

export function MeetingNotesSettings({ value, onChange }: { value: MeetingNotesValue; onChange: (change: MeetingNotesChange) => void }) {
  return (
    <Container layout="vertical" gap="md" padding="md" minWidth="0">
      <Container layout="vertical" gap="sm" minWidth="0">
        <Text variant="heading">{settings.notes.title}</Text>
        <Text variant="body" color="subtle">{settings.notes.description}</Text>
        <ChoiceTiles kind="radio" label={settings.notes.label} tiles={settings.notes.options}
          chosen={value.sendNotesTo} onPick={tile => onChange({ sendNotesTo: tile.id })} />
      </Container>
      {settings.toggles.map(toggle => (
        <Container key={toggle.id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" minWidth="0">
          <Container layout="vertical" gap="xs" minWidth="0">
            <Text variant="body">{toggle.label}</Text>
            <Text variant="body-xs" color="faint">{toggle.description}</Text>
          </Container>
          <Switch size="md" label={toggle.label} checked={toggleValue(value, toggle.id)}
            onCheckedChange={checked => onChange(toggleChange(toggle.id, checked))} />
        </Container>
      ))}
      <LanguageChooser chosen={value.languages} onChange={languages => onChange({ languages })} />
    </Container>
  );
}
