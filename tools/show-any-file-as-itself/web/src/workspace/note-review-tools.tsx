// src/workspace/note-review-tools.tsx
//
// PURPOSE
//   The tools on a meeting note's Summary and Action Items tabs (meeting-review.json summary_tools, action_tools): the
//   template and language the next AI review is asked for (and the person's own templates, kept as their snippets),
//   copy and PDF for the summary and the action items, a rating of the summary, and the action items grouped by speaker
//   with a checkbox each and one button that puts them all in the person's Inbox as tasks.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A task is made and ticked only through the calendar task owner (/work/api/calendar/tasks); a tick is that
//      task's status, so it is the same on every screen. Adding the same list again makes no second task.
//   2. A template of the person's own is a snippet tagged with the DATA tag (src/snippets.mjs through the posts road):
//      add, change and remove all go there. Nothing is cached across pages.
//   3. A rating is a `summary-feedback` result beside the file (the namespace merge), never a message.
//   4. Every word is DATA; nothing here shows an id.

import React from 'react';
import { Button, Container, Input, Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue, Text, Textarea } from '../../parts/ui';
import { Checkbox } from '../../parts/ui/show/coss/ui/checkbox';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { postJson, readJson, fileResults } from './api';
import { copyNoteText, saveNotePdf } from './note-actions';
import { groupBySpeaker, ratingOf, taskForItem, taskIdOf } from './note-review.mjs';
import tasks from '../calendar-tasks.json' with { type: 'json' };
import meetingReview from './meeting-review.json' with { type: 'json' };

const summary = meetingReview.summary_tools, summaryWords = summary.words;
const actions = meetingReview.action_tools, actionWords = actions.words;
const SNIPPETS = '/work/api/posts/snippet';
const TASKS = '/work/api/calendar/tasks';

export type OwnTemplate = { id: string; label: string; text: string };
type Snippet = { snippet_id: string; title: string; text: string };

/** The person's own summary templates, with the calls that add, change and remove them. */
export function useOwnTemplates() {
  const [own, setOwn] = React.useState<OwnTemplate[]>([]);
  const [failed, setFailed] = React.useState(false);
  const read = React.useCallback(() => postJson<{ snippets: Snippet[] }>(`${SNIPPETS}/list`, { tag: summary.own_tag }).then(answer => {
    setOwn((answer.snippets ?? []).map(row => ({ id: row.snippet_id, label: row.title, text: row.text }))); setFailed(false);
  }, () => setFailed(true)), []);
  React.useEffect(() => { void read(); }, [read]);
  const save = React.useCallback(async (row: { id?: string; label: string; text: string }) => {
    try {
      await postJson(`${SNIPPETS}/save`, { ...(row.id ? { snippet_id: row.id } : {}), title: row.label, text: row.text, tags: [summary.own_tag] });
      notify(summaryWords.template_saved, { kind: 'done' }); await read(); return true;
    } catch (error) { notify(summaryWords.template_error, { kind: 'error', detail: errorWords(error) }); return false; }
  }, [read]);
  const remove = React.useCallback(async (id: string) => {
    try { await postJson(`${SNIPPETS}/remove`, { snippet_id: id }); notify(summaryWords.template_removed, { kind: 'done' }); await read(); }
    catch (error) { notify(summaryWords.template_error, { kind: 'error', detail: errorWords(error) }); }
  }, [read]);
  return { own, failed, save, remove };
}

export type SummaryChoice = { template: string; language: string };

/** What the next review is asked for: the template and language pickers, and the person's own templates editor. */
export function SummaryChoices({ choice, onChoice, templates }: { choice: SummaryChoice; onChoice: (next: SummaryChoice) => void; templates: ReturnType<typeof useOwnTemplates> }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<{ id?: string; label: string; text: string } | null>(null);
  const stock = summary.templates.map(row => ({ value: row.id, label: row.label }));
  const mine = templates.own.map(row => ({ value: row.id, label: row.label }));
  const languages = summary.languages.map(row => ({ value: row.id || 'same', label: row.label }));
  return <Container layout="vertical" gap="xs">
    <Container layout="horizontal" gap="sm" wrap alignItems="center">
      <Select items={[...stock, ...mine]} value={choice.template} onValueChange={value => { if (typeof value === 'string') onChoice({ ...choice, template: value }); }}>
        <SelectTrigger aria-label={summaryWords.template}><SelectValue placeholder={summaryWords.template} /></SelectTrigger>
        <SelectPopup>
          <SelectGroup>{stock.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup>
          {mine.length ? <SelectGroup><SelectGroupLabel>{summaryWords.own_group}</SelectGroupLabel>{mine.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup> : null}
        </SelectPopup>
      </Select>
      <Select items={languages} value={choice.language || 'same'} onValueChange={value => { if (typeof value === 'string') onChoice({ ...choice, language: value === 'same' ? '' : value }); }}>
        <SelectTrigger aria-label={summaryWords.language}><SelectValue placeholder={summaryWords.language} /></SelectTrigger>
        <SelectPopup>{languages.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
      </Select>
      <Button variant="ghost" size="sm" onClick={() => setEditing(open => !open)}>{editing ? summaryWords.done_templates : summaryWords.edit_templates}</Button>
    </Container>
    <Text variant="body" color="subtle">{summaryWords.rerun_hint}</Text>
    {editing ? <Container layout="vertical" gap="xs" aria-label={summaryWords.edit_templates}>
      {templates.failed ? <Text variant="body" color="subtle" role="alert">{summaryWords.templates_failed}</Text> : null}
      {!templates.failed && !templates.own.length ? <Text variant="body" color="subtle">{summaryWords.templates_empty}</Text> : null}
      {templates.own.map(row => <Container key={row.id} layout="horizontal" gap="sm" alignItems="center" wrap>
        <Text variant="body">{row.label}</Text>
        <Button variant="ghost" size="sm" onClick={() => setDraft({ id: row.id, label: row.label, text: row.text })}>{summaryWords.edit_template}</Button>
        <Button variant="ghost" size="sm" onClick={() => { return templates.remove(row.id); }}>{summaryWords.remove_template}</Button>
      </Container>)}
      {draft ? <Container layout="vertical" gap="xs">
        <Input aria-label={summaryWords.template_name} placeholder={summaryWords.template_name} value={draft.label} onChange={event => setDraft({ ...draft, label: event.target.value })} />
        <Textarea aria-label={summaryWords.template_text} placeholder={summaryWords.template_text} value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} />
        <Button variant="outline" size="sm" disabled={!draft.label.trim() || !draft.text.trim()} onClick={() => { return templates.save(draft).then(saved => { if (saved) setDraft(null); }); }}>{summaryWords.save_template}</Button>
      </Container> : <Button variant="outline" size="sm" onClick={() => setDraft({ label: '', text: '' })}>{summaryWords.new_template}</Button>}
    </Container> : null}
  </Container>;
}

/** Copy, PDF and a rating for the saved summary. */
export function SummaryTools({ identity, title, text }: { identity: string; title: string; text: string }) {
  const [rating, setRating] = React.useState('');
  React.useEffect(() => {
    let current = true;
    setRating('');
    void fileResults.read<{ results: { value: unknown }[] }>(identity, summary.feedback_kind)
      .then(answer => { if (current) setRating(ratingOf(answer.results.map(result => result.value as { rating?: string }))); }, () => {});
    return () => { current = false; };
  }, [identity]);
  const rate = async (next: 'up' | 'down') => {
    try {
      await fileResults.merge(identity, { kind: summary.feedback_kind, value: { rating: next }, produced_by: summary.feedback_by });
      setRating(next); notify(summaryWords.rated, { kind: 'done' });
    } catch (error) { notify(summaryWords.rate_failed, { kind: 'error', detail: errorWords(error) }); }
  };
  if (!text) return null;
  return <Container layout="horizontal" gap="sm" wrap alignItems="center">
    <Button variant="outline" size="sm" onClick={() => { return copyNoteText(text, { done: summaryWords.copied, failed: summaryWords.copy_failed, detail: summaryWords.copy_detail }); }}>{summaryWords.copy}</Button>
    <Button variant="outline" size="sm" onClick={() => { saveNotePdf(title, [{ heading: summaryWords.pdf_heading, text }], { done: summaryWords.pdf_done, failed: summaryWords.pdf_failed, detail: summaryWords.pdf_detail }); }}>{summaryWords.pdf}</Button>
    <Text variant="body" color="subtle">{summaryWords.rating_prompt}</Text>
    <Button variant={rating === 'up' ? 'outline' : 'ghost'} size="sm" aria-pressed={rating === 'up'} onClick={() => { return rate('up'); }}>{summaryWords.rate_up}</Button>
    <Button variant={rating === 'down' ? 'outline' : 'ghost'} size="sm" aria-pressed={rating === 'down'} onClick={() => { return rate('down'); }}>{summaryWords.rate_down}</Button>
  </Container>;
}

type Item = { text: string; speaker: string; index: number };
type TaskState = 'absent' | 'open' | 'done';

/** The saved action items by speaker, a checkbox each, and one button that adds them all to the person's Inbox. */
export function ActionItemsPanel({ identity, title, items }: { identity: string; title: string; items: Item[] }) {
  const [state, setState] = React.useState<Record<number, TaskState>>({});
  const [unread, setUnread] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const shown = React.useMemo(() => items.slice(0, actions.read_cap), [items]);
  const requests = React.useMemo(() => shown.map(item => taskForItem({ identity, item, limits: tasks.limits, minutes: actions.minutes })), [identity, shown]);
  const read = React.useCallback(async () => {
    try {
      const found = await Promise.all(requests.map(async request => {
        try {
          const answer = await readJson<{ tasks: { id: string; status: string }[] }>(`${TASKS}?task_id=${encodeURIComponent(taskIdOf(request))}`);
          const task = answer.tasks.find(row => row.id === taskIdOf(request));
          return task ? (task.status === 'Done' ? 'done' : 'open') : 'absent';
        } catch { return 'absent'; }
      }));
      setState(Object.fromEntries(found.map((value, index) => [shown[index].index, value as TaskState]))); setUnread(false);
    } catch { setUnread(true); }
  }, [requests, shown]);
  React.useEffect(() => { void read(); }, [read]);
  const make = (request: (typeof requests)[number]) => postJson(TASKS, request);
  const addAll = async () => {
    setBusy(true);
    const results = await Promise.allSettled(requests.filter((_, at) => !state[shown[at].index] || state[shown[at].index] === 'absent').map(make));
    setBusy(false);
    if (results.some(result => result.status === 'rejected')) notify(actionWords.added_some, { kind: 'error' }); else notify(actionWords.added_all, { kind: 'done' });
    await read();
  };
  const tick = async (item: Item, done: boolean) => {
    const request = requests[shown.indexOf(item)];
    try {
      if (state[item.index] === 'absent' || !state[item.index]) await make(request);
      await postJson(TASKS, { action: done ? 'complete' : 'reopen', task_id: taskIdOf(request) });
    } catch (error) { notify(actionWords.failed, { kind: 'error', detail: errorWords(error) }); }
    await read();
  };
  const words = shown.map(item => `${item.speaker ? `${item.speaker}: ` : ''}${item.text}`).join('\n');
  if (!shown.length) return null;
  return <Container layout="vertical" gap="sm" aria-label={actionWords.list_label}>
    {unread ? <Text variant="body" color="subtle" role="alert">{actionWords.unread}</Text> : null}
    {groupBySpeaker(shown, actionWords.no_speaker).map(group => <Container key={group.speaker} layout="vertical" gap="xs">
      <Text variant="heading-sm" color="strong">{group.speaker}</Text>
      {group.items.map(item => <Container key={item.index} layout="horizontal" gap="sm" alignItems="center">
        <Checkbox aria-label={`${state[item.index] === 'done' ? actionWords.mark_open : actionWords.mark_done}: ${item.text}`} checked={state[item.index] === 'done'} disabled={busy}
          onCheckedChange={checked => { void tick(item, checked === true); }} />
        <Text variant="body" color={state[item.index] === 'done' ? 'subtle' : undefined}>{item.text}</Text>
        {state[item.index] === 'open' || state[item.index] === 'done' ? <Text variant="body" color="subtle">{actionWords.added}</Text> : null}
      </Container>)}
    </Container>)}
    <Container layout="horizontal" gap="sm" wrap alignItems="center">
      <Button variant="outline" size="sm" loading={busy} disabled={busy || shown.every(item => state[item.index] && state[item.index] !== 'absent')} onClick={() => { return addAll(); }}>{actionWords.add_all}</Button>
      <Button variant="outline" size="sm" onClick={() => { return copyNoteText(words, { done: actionWords.copied, failed: actionWords.copy_failed, detail: actionWords.copy_detail }); }}>{actionWords.copy}</Button>
      <Button variant="outline" size="sm" onClick={() => { saveNotePdf(title, [{ heading: actionWords.pdf_heading, text: words }], { done: actionWords.pdf_done, failed: actionWords.pdf_failed, detail: actionWords.pdf_detail }); }}>{actionWords.export_pdf}</Button>
    </Container>
  </Container>;
}
