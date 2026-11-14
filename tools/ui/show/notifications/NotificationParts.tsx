// packages/ui/show/notifications/NotificationParts.tsx
//
// PURPOSE
// What every notification view shares: a notification as one glance row
// (parts/ui/show/listing-card, form "row", whole): who it is about as its face
// (turning while they are at it), else the kind's icon in a tile tinted by its
// tone; the whole title; one quiet line under it (how far its work has got, its
// detail, and when, kept current while it runs); a chip or badge only where its
// DATA still gives one; how far it has got as the key value on the right (and as
// a ring on the tile while it runs); and its own buttons, except the action that
// is the row's own press, which makes the whole row open it. The stacked toast and the notification center both
// draw it, so a notification reads the same everywhere and the same way as every
// other thing Trillion shows at a glance.
//
// NON-NEGOTIABLE INVARIANTS
// 1. Kind -> icon/tone and tone -> glance tone are DATA (notification-kinds.json
//    beside this file). No kind name appears in this file.
// 2. Nothing here draws its own markup for a notification: the row is ListingCard,
//    and a caller's own controls (close, mark as read) ride as its `controls`.
// 3. An action whose promise is still running keeps the row's buttons from being
//    pressed again; an action that dismisses (the default) dismisses after it ran.
// 4. A press anywhere on a notification opens its thing (ListingCard invariant 2): the action marked `press` is the
//    row's own press and is never drawn as a button; its other actions are buttons beside it, each its own control.
// 5. An action that asks for words (`input`, a reply) is answered in place: its button
//    opens a field over the notification (the coss Popover), and Send runs the action
//    with the words, its face showing the work going on, done or failed.
// 6. Several notifications that say the same thing read as one row: `count` shows how
//    many as the row's key value; the view that grouped them lists each when asked.
//
// References (anatomy only, original code): visual-hierarchy pair 10 (a turning
// ring around the actor, the title, the time muted under it), 21st.dev #29323
// "Agent Progress" (activity glyph, action label, live elapsed time), Mobbin
// Devin "Worked for 11s" and Browserbase "Running 15.0s"; 21st.dev #2527 "Google Drive
// Uploader Toast" (progress ring around the file glyph), 21st.dev #28243
// "Animated Toast" (tone accent, inline Undo); the glance shape of
// the visual-hierarchy sheets (a notification is a row).

import React from 'react';
import kindsData from './notification-kinds.json';
import waitingOnYou from '../../../../src/waiting-on-you.json';
import {Button} from '../coss/ui/button';
import {ShowRuleMenu} from '../show-rules/ShowRuleMenu';
import {NOTICE_SUBJECT, noticeThing} from './notification-center';
import {Popover, PopoverPopup, PopoverTrigger} from '../coss/ui/popover';
import {Textarea} from '../coss/ui/textarea';
import type {Listing} from '../listing-card';
import {later} from '../load-later/later';
import type {NotificationAction, NotificationRecord} from './notification-center';
import {relativeWhen} from '../relative-time/relative-time';
import {sanitizeErrorText} from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';

// The row arrives with the first notification drawn, not with the page (../load-later/later.ts).
const ListingCard = later(() => import('../listing-card/ListingCard'), module => module.ListingCard);

export type NotificationKindAppearance = {icon: string; tone: string};
/** A kind whose words pass the failure-words gate, with what shows when the title cannot pass. */
type GatedWords = {title: string; detail: string};
const kinds = {...kindsData.kinds, ...waitingOnYou.presentation.notification_kinds} as Record<string, Partial<NotificationKindAppearance> & {gate_words?: GatedWords}>;
const glanceTones = kindsData.listing_tones as Record<string, string>;

/** The resolved look of a kind: its DATA row, or the fallback. */
export function notificationKindAppearance(kind?: string | null): NotificationKindAppearance {
  const row = kind ? kinds[kind] : undefined;
  return {
    icon: row?.icon ?? kindsData.fallback.icon,
    tone: row?.tone ?? kindsData.fallback.tone,
  };
}

const glanceTone = (tone?: string) => (tone ? glanceTones[tone] : undefined);

/** The words for when a notification happened: how long its work has been going while someone is at it, else how long
 *  ago it happened. */
export function notificationWhen(record: NotificationRecord, now = Date.now()): string {
  return relativeWhen(record.at ?? record.createdAt, now);
}

/** Whether someone is at the work now: the record says so, or, when it does not say, it is running. */
const isWorking = (record: NotificationRecord) => (record.working ?? record.running) === true;

/** A notification as glance DATA. `when` is already in words ("just now", "2 min ago"); left out, the row has none. */
export function notificationListing(record: NotificationRecord, when?: string, count?: number): Listing {
  const look = notificationKindAppearance(record.kind);
  const value = record.running ? record.progress?.value : undefined;
  const measured = typeof value === 'number';
  const percent = measured ? Math.round(Math.max(0, Math.min(1, value)) * 100) : null;
  const states = (record.chips ?? []).filter(chip => glanceTone(chip.tone) && glanceTone(chip.tone) !== glanceTone(kindsData.fallback.tone));
  const names = (record.chips ?? []).filter(chip => !states.includes(chip));
  const gate = record.kind ? kinds[record.kind]?.gate_words : undefined;
  const title = gate ? sanitizeErrorText(record.title, gate.title) : record.title;
  const detail = gate && record.detail ? sanitizeErrorText(record.detail, gate.detail) : record.detail;
  const text = [record.running ? record.progress?.label : undefined, detail].filter(Boolean).join(' · ');
  const buttons = record.actions.filter(action => !action.press && !action.input);
  // A face shows who is at it by turning; without one, work going on shows on the kind's tile (a ring or the loading mark).
  const progress = measured ? value : !record.face && isWorking(record) ? null : undefined;
  return {
    id: record.id,
    form: 'row',
    whole: true,
    title,
    icon: look.icon,
    tone: glanceTone(look.tone),
    ...(record.preview ? {picture: record.preview} : {}),
    ...(record.face ? {face: {...record.face, working: isWorking(record) && !measured}} : {}),
    ...(when ? {when} : {}),
    ...(text ? {text} : {}),
    ...(names.length ? {chips: names.map(chip => ({label: chip.text}))} : {}),
    ...(states[0] ? {badge: {label: states[0].text, tone: glanceTone(states[0].tone)}} : {}),
    ...(progress !== undefined ? {progress} : {}),
    ...(percent !== null ? {value: String(percent), unit: '%', valueLabel: `${percent}% done`}
      : count && count > 1 ? {value: String(count), unit: kindsData.words.together_unit, valueLabel: kindsData.words.together.replace('{count}', String(count))} : {}),
    ...(buttons.length ? {actions: buttons.map(action => ({id: action.id ?? String(record.actions.indexOf(action)), label: action.label, ...(action.icon ? {icon: action.icon} : {}), ...(action.danger ? {danger: true} : {})}))} : {}),
  };
}

export interface NotificationRowProps {
  record: NotificationRecord;
  /** Hides the notification where it is shown, after an action that dismisses. */
  onDismiss: () => void;
  /** When it happened, in words; left out, the row says how long ago from the record's own time and keeps it current. */
  when?: string;
  /** The view's own controls (close, mark as read), drawn after the notification's buttons. */
  controls?: React.ReactNode;
  /** How many notifications this row stands for, when a view groups the ones that say the same thing. */
  count?: number;
  className?: string;
}

/** How often a row with work going on reads its time again, so "2 min ago" keeps up while the person watches. */
const TICK_MS = 30_000;

/** One notification as a glance row: its buttons run the notification's own actions, and an action marked `press` is
 *  the row's own press (the whole row opens it, with no button for it). */
/** An action that asks for words: its button opens a field over the notification; Send runs it with them. */
function AnswerInPlace({action, run}: {action: NotificationAction; run: (text: string) => Promise<void>}) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const send = async () => {
    const words = text.trim();
    if (!words) return;
    await run(words);
    setText('');
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" size="sm" variant="outline" />}>{action.label}</PopoverTrigger>
      <PopoverPopup side="bottom" align="end" sideOffset={6} portalProps={{className: 'coss-ui'}} className="notification-answer" data-slot="notification-answer">
        <Textarea value={text} rows={3} autoFocus placeholder={action.input?.placeholder} aria-label={action.label}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
        <Button type="button" size="sm" className="notification-answer-send" disabled={!text.trim()} onClick={send}>
          {action.input?.button ?? action.label}
        </Button>
      </PopoverPopup>
    </Popover>
  );
}

export function NotificationRow({record, onDismiss, when, controls, count, className}: NotificationRowProps) {
  const busy = React.useRef(false);
  const [now, setNow] = React.useState(() => Date.now());
  const ticking = record.running && when === undefined;
  React.useEffect(() => {
    if (!ticking) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const run = async (index: number) => {
    const action = record.actions[index];
    if (!action || busy.current) return;
    busy.current = true;
    try { await action.onAction?.(); }
    catch (error) { console.error('Notification action failed', error); }
    finally { busy.current = false; }
    if (action.dismisses !== false) onDismiss();
  };
  // A field's Send: a refusal is thrown on, so the Send button shows it failed and keeps the words.
  const answer = async (action: NotificationAction, text: string) => {
    await action.onAction?.(text);
    if (action.dismisses !== false) onDismiss();
  };
  const answers = record.actions.filter(action => action.input && !action.press);
  const onAction = (actionId: string) => run(record.actions.findIndex((action, at) => (action.id ?? String(at)) === actionId));
  const press = record.actions.findIndex(action => action.press);
  return (
    <ListingCard
      listing={notificationListing(record, when ?? notificationWhen(record, now), count)}
      onAction={(_id, action) => { void onAction(action); }}
      onOpen={press >= 0 ? () => { void run(press); } : undefined}
      controls={<>
        {answers.map(action => <AnswerInPlace key={action.id ?? action.label} action={action} run={text => answer(action, text)} />)}
        {controls}
        {/* Silence or hide notices like this one (for an hour, until tomorrow, always, on this device), from the page's
            show rules; the menu draws nothing until the rules are loaded. */}
        <ShowRuleMenu subject={NOTICE_SUBJECT} thing={noticeThing(record, 'toast')} className="notification-show-rule" />
      </>}
      className={className}
    />
  );
}
