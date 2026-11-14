// src/workspace/add-pages.tsx
//
// PURPOSE
//   The Add pages picker on Connections (the Connected menu's "Add pages" of Amie's integrations): every page this
//   account is offered, the Marketplace catalogue's screens beside the app's own, searchable, each added to a sidebar list
//   the person picks. A guide section places it by name (`part: 'add-pages'`, guide-screens.tsx LENT_PARTS).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The pages are the sidebar's own offer (GET /sidebar `rows`, src/sidebar.mjs), never a second list of screens here,
//      so a screen the Marketplace gains is offered the moment the sidebar offers it.
//   2. An add is the sidebar's own change (`add`, the verb change_sidebar takes); the page's sidebar follows the same
//      records, so the page appears there without a reload.
//   3. A page already in the chosen list says so and cannot be added twice. A failed add says so; it never looks done.
//   4. Every word is DATA (add-pages.json); no id is shown.

import React from 'react';
import { Button, Container, Input, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text } from '../../parts/ui';
import { notify } from '../../parts/ui/show/coss/notifications';
import { ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import settings from './add-pages.json' with { type: 'json' };

const words = settings.words;
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);

type SidebarRead = { lists: { list_id: string; name: string; rows: { row_id: string; label: string }[] }[]; rows: { row_id: string; label: string }[] };

export function AddPages() {
  const loaded = useScreenLoad('add-pages-sidebar', { read: () => readJson<SidebarRead>(settings.read, { cache: 'no-store' }, false, { applyFocus: false }), loading: { label: words.loading, layout: 'rows' }, failed: refusal(words.failed) });
  const [listId, setListId] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState('');
  if (loaded.state) return <ScreenState state={loaded.state} />;
  const { lists, rows } = loaded.value;
  if (!lists.length) return <Text variant="body" color="subtle">{words.no_lists}</Text>;
  const list = lists.find(item => item.list_id === listId) ?? lists[0];
  const inList = new Set(list.rows.map(row => row.row_id));
  const asked = query.trim().toLowerCase();
  const matching = rows.filter(row => !asked || row.label.toLowerCase().includes(asked));
  const shown = matching.slice(0, settings.shown_most);
  const add = async (row: { row_id: string; label: string }) => {
    setBusy(row.row_id);
    try {
      await postJson(settings.change, { changes: [{ do: 'add', list_id: list.list_id, row_id: row.row_id }] });
      notify(fill(words.done, { page: row.label, list: list.name }), { kind: 'done' });
      await loaded.reload();
    } catch (error) { notify(words.not_added, { kind: 'error', detail: errorWords(error) }); }
    finally { setBusy(''); }
  };
  return <Container layout="vertical" gap="sm" className="add-pages">
    <Container layout="horizontal" gap="sm" wrap alignItems="center">
      <Input aria-label={words.search} placeholder={words.search} value={query} onChange={event => setQuery(event.target.value)} />
      <Select items={lists.map(item => ({ value: item.list_id, label: item.name }))} value={list.list_id} onValueChange={value => { if (typeof value === 'string') setListId(value); }}>
        <SelectTrigger aria-label={words.list}><SelectValue placeholder={words.list} /></SelectTrigger>
        <SelectPopup>{lists.map(item => <SelectItem key={item.list_id} value={item.list_id}>{item.name}</SelectItem>)}</SelectPopup>
      </Select>
    </Container>
    {shown.length ? shown.map(row => <Container key={row.row_id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
      <Text variant="body">{row.label}</Text>
      {inList.has(row.row_id) ? <Text variant="body" color="subtle">{words.added}</Text>
        : <Button variant="outline" size="sm" disabled={busy !== ''} onClick={() => { return add(row); }}>{busy === row.row_id ? words.adding : words.add}</Button>}
    </Container>) : <Text variant="body" color="subtle">{words.none}</Text>}
    {matching.length > shown.length ? <Text variant="body" color="subtle">{fill(words.more, { count: String(shown.length) })}</Text> : null}
  </Container>;
}
