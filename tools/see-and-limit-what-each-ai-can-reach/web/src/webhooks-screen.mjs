// src/webhooks-screen.mjs
//
// Purpose
//   The Webhooks section of AI apps & keys (src/ai-apps-screen.mjs aiAppsFacts): the person's own webhooks, one row
//   each with Send a test and Remove, a form that adds one (address, and the event it sends on), and the headers every
//   signed message carries. The webhooks are the MCP Events subscriptions (src/mcp-events.mjs) whose reader is the
//   person's screen; this file only describes them and reads what a form sent. Words and the headers' documentation
//   are DATA (src/webhooks-screen.json); the events are src/mcp-events.json.
//
// Non-negotiable invariants
//   1. The form's event choice comes from the events' own rows (src/mcp-events.json, their `label`); no event is named here.
//   2. A secret is never put in a description: it is made when the webhook is added and answered once.
//   3. A webhook that could not be read is said so; an empty list is only a list that was read and holds nothing.
//
import words from './webhooks-screen.json' with { type: 'json' };
import { personEvents } from './mcp-events.mjs';
import { dayWords as day } from './screen-day.mjs';

export const WEBHOOK_WORDS = words;

const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));

/** The section. `hooks` is the person's webhooks (mcp-events live, without secrets), or null when they could not be read. */
export function webhooksSection(hooks, events = personEvents()) {
  const labels = new Map(events.map(event => [event.name, event.label ?? words.unnamed_event]));
  return {
    id: 'webhooks',
    heading: words.heading,
    body: words.body,
    rows: [
      ...(hooks ?? []).map(hook => ({
        id: hook.id,
        title: hook.label ?? new URL(hook.url).host + new URL(hook.url).pathname.replace(/\/$/, ''),
        detail: fill(hook.label ? words.row_detail_with_address : words.row_detail, { address: new URL(hook.url).host, event: labels.get(hook.name) ?? hook.name, day: day(hook.created_at),
          last: hook.last_delivered_at ? fill(words.last_sent, { day: day(hook.last_delivered_at) }) : hook.delivered ? fill(words.sent_count, { count: hook.delivered }) : '' }),
        actions: [
          { label: words.actions.send_test, icon: 'Send', tone: 'plain', send: { path: '/work/api/account/webhooks/test', body: { id: hook.id } } },
          { label: words.actions.remove, icon: 'Trash2', tone: 'plain-danger', send: { path: '/work/api/account/webhooks/remove', body: { id: hook.id }, confirm: words.actions.remove_confirm } },
        ],
      })),
      ...(hooks ? [{
        id: 'add-a-webhook', title: words.add.title, open_label: words.add.open, starts_open: !hooks.length,
        fields: [
          { name: 'label', label: words.add.name_label, secret: false, placeholder: words.add.name_placeholder },
          { name: 'url', label: words.add.url_label, secret: false, placeholder: words.add.url_placeholder },
          { name: 'event', label: words.add.event_label, kind: 'choice', value: events[0]?.name, options: events.map(event => ({ value: event.name, label: event.label ?? words.unnamed_event })) },
        ],
        actions: [{ label: words.add.button, tone: 'primary', busy_label: words.add.busy, send: { path: '/work/api/account/webhooks/new', with_fields: true } }],
      }] : []),
      {
        id: 'webhook-messages', title: words.docs.title, detail: words.docs.body,
        steps: [
          ...words.docs.headers.map(header => ({ title: header.name, body: header.about })),
          { title: 'Signature', code: words.docs.signature, body: words.docs.secret_note },
          { title: 'Retries', body: words.docs.retry },
        ],
        open_label: words.docs.open,
      },
    ],
    note: hooks ? (hooks.length ? undefined : words.empty) : words.unreadable,
  };
}

/** What the add form sent, as the subscription it asks for: { name, url, label } or throws an Error in plain words. */
export function webhookFromForm(values = {}, events = personEvents()) {
  const event = events.find(item => item.name === values.event);
  if (!event) throw new Error(words.said.need_event);
  return { name: event.name, url: typeof values.url === 'string' ? values.url.trim() : '', label: typeof values.label === 'string' ? values.label.trim() : '' };
}
