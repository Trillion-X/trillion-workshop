// src/workspace/email-todo-settings.tsx
//
// PURPOSE
//   The settings for email that becomes todos: whether new mail lands in the Email list, whether Split contents routes
//   calendar invites to Calendar and newsletters and spam to Other, which connected mail account is read, and a button
//   that imports what is loaded now. Each switch is one preference on /work/api/calendar/tasks (set_preferences).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every word is DATA (todo-lists-settings.json); the routing itself is the server's (src/calendar-task-messages.mjs).
//   2. The form shows what the road holds; a failed write says so and changes nothing.
//   3. Importing is the person's press: nothing is imported by opening the page. The button shows only when the screen
//      can hand over the mail it has loaded (`onImport`).
import React from 'react';
import { Button, Container, errorWords, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, Text } from '../../parts/ui';
import words from './todo-lists-settings.json' with { type: 'json' };
import { postJson, readJson } from './api';
import { preferenceRequest } from './todo-lists-settings.mjs';

type Preferences = { email_todos?: boolean; email_split_contents?: boolean; email_todo_account?: string };
type Notify = (message: string, options?: { kind?: 'info' | 'error' }) => void;
const ROAD = '/work/api/calendar/tasks';
const ANY = '';

export function EmailTodoSettings({ accounts, notify, onImport }: { accounts: { id: string; label: string }[]; notify: Notify; onImport?: () => Promise<number> }): React.ReactElement {
  const [stored, setStored] = React.useState<Preferences | null>(null);
  const [importing, setImporting] = React.useState(false);
  const load = React.useCallback(async () => {
    const read = await readJson<{ preferences: Preferences }>(`${ROAD}?check=${crypto.randomUUID()}`);
    setStored(read.preferences);
  }, []);
  React.useEffect(() => { void load().catch(() => undefined); }, [load]);
  const write = async (name: keyof Preferences, value: boolean | string) => {
    try { await postJson(ROAD, preferenceRequest(name, value)); notify(words.email_saved, { kind: 'info' }); await load(); }
    catch (error) { notify(errorWords(error) || words.email_failed, { kind: 'error' }); }
  };
  const run = async () => {
    if (importing || !onImport) return;
    setImporting(true);
    try {
      const count = await onImport();
      notify(count ? words.email_imported.replace('{count}', String(count)) : words.email_import_none, { kind: 'info' });
    } catch (error) { notify(errorWords(error) || words.email_failed, { kind: 'error' }); }
    finally { setImporting(false); }
  };
  if (!stored) return <></>;
  const account = stored.email_todo_account ?? ANY;
  const choices = [{ value: ANY, label: words.email_account_any }, ...accounts.map(row => ({ value: row.id, label: row.label }))];
  return <Container layout="vertical" gap="sm" data-email-todo-settings>
    <Text variant="body-sm" weight="semibold">{words.email_heading}</Text>
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="body-sm">{words.email_todos}</Text>
      <Switch checked={stored.email_todos === true} label={words.email_todos} size="sm" onCheckedChange={value => void write('email_todos', value)} />
    </Container>
    <Text variant="caption" color="muted">{words.email_todos_about}</Text>
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="body-sm">{words.email_split}</Text>
      <Switch checked={stored.email_split_contents !== false} label={words.email_split} size="sm" onCheckedChange={value => void write('email_split_contents', value)} />
    </Container>
    <Text variant="caption" color="muted">{words.email_split_about}</Text>
    <Text variant="caption" color="muted">{words.email_account}</Text>
    <Select items={choices} value={account} onValueChange={value => { if (typeof value === 'string') void write('email_todo_account', value); }}>
      <SelectTrigger aria-label={words.email_account}><SelectValue /></SelectTrigger>
      <SelectPopup>{choices.map(row => <SelectItem key={row.value} value={row.value}>{row.label}</SelectItem>)}</SelectPopup>
    </Select>
    {onImport ? <Button size="sm" variant="outline" disabled={importing} onClick={() => run()}>{importing ? words.email_importing : words.email_import}</Button> : null}
  </Container>;
}
