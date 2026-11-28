// tools/take-a-booking-one-step-at-a-time/show/BookingPage.tsx
//
// PURPOSE
//   The screen of tool:read-a-booking-page: a booking made one step at a time. It asks for the email, then each question of the
//   page, then offers the open times from the page's calendar, asks the person to confirm one, and shows the booking, flat on the
//   page (no card, no drop shadow), one thing on the screen at a time, under one progress piece per step (../../ask-questions-sort-answers-follow-up/show/step-pieces.ts), each
//   new step opening at the top of the page. The site's
//   booking routes say what comes next; this screen draws the step it is given. It does not wait on the network between questions:
//   the booking's start hands over the page's questions with how each answer is checked, and the answers are checked here, the next
//   question drawn at once and the answers sent in the background, in order (../../ask-questions-sort-answers-follow-up/show/
//   use-optimistic-form.ts). Only a step that needs the server's fact waits, inside its button: the first step (the email opens the
//   booking), the times read from the calendar after the last question, the time chosen (it may have been taken) and the booking.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Rendering is pure: nothing is fetched and no window is read while it renders (the server draws the first step). After it is
//      mounted an effect reads `?email=` from the address (an email already given starts the booking at its first question, so the
//      email is asked once; while it starts, the email step shows that email with its button pending) and
//      every call to `<api_base>/book.start|answer|slots|slot|confirm` is made from an effect or a press.
//   2. Props are plain JSON: `page` (the page's name), `title`, `timezone`, `duration_minutes`, `questions`
//      ([{position, prompt, required}]), `words` (any of the words below, replacing the plain defaults) and `api_base`.
//   3. A time that is refused (taken since the times were read) takes the visitor back to the times, without it, with the tool's
//      words. A refusal the routes make on purpose carries its own words as `error`, and when the step tool refused in its own words
//      `why` too: the error line shows `why` when it is there and `error` when it is not; any other failure shows `words.failed`.
//   4. A question is a form question: its type picks its control through ./FormSteps (shared with the form page), and the server
//      checks the answer the same way. Times are drawn in the page's time zone.
//   5. Everything drawn is a shared part (Container, Text, Button, the Coss Input and TimeSlotPicker); no raw HTML, no inline
//      styling. The progress is one piece per step (the shared FormSteps StepPieces, step-pieces.ts piecesOf: done solid, current half, ahead faint), never one
//      continuous bar, and each piece carries `data-step-piece` with what it shows.
//   6. A step drawn after another opens at the top of the page (step-pieces.ts useStepOpensAtTop); the first step stays where the
//      page put it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React, { useEffect, useRef, useState } from 'react';
import { Container } from '../../ui/show/container/index.ts';
import { Text } from '../../ui/show/text/Text.tsx';
import { Form } from '../../ui/show/form/Form.tsx';
import { Input } from '../../ui/show/coss/ui/input.tsx';
import { Button } from '../../ui/show/coss/ui/button.tsx';
import { TimeSlotPicker } from '../../ui/show/coss/time-slot-picker.tsx';
import { SectionShell, TextColumn } from '../../ui/show/marketing-page/MarketingPagePrimitives.tsx';
import { AnswerControl, Labelled, StepPieces, answered, type Answer, type Next as AskedNext } from '../../ask-questions-sort-answers-follow-up/show/FormSteps.tsx';
import { controlFor } from '../../ask-questions-sort-answers-follow-up/read-data/step-controls.ts';
import { callStep as call } from '../../ask-questions-sort-answers-follow-up/show/call-step.ts';
import type { Definition } from '../../ask-questions-sort-answers-follow-up/show/optimistic-run.ts';
import { useOptimisticForm } from '../../ask-questions-sort-answers-follow-up/show/use-optimistic-form.ts';
import { holdSlot, withoutSlot, type Slot } from './hold-slot.ts';
import { useStepOpensAtTop } from '../../ask-questions-sort-answers-follow-up/show/step-pieces.ts';

export type BookingWords = Record<string, string>;
export type BookingPageProps = {
  page: string;
  title: string;
  timezone: string;
  duration_minutes: number;
  questions: { position: number; prompt: string; required: boolean }[];
  /** Any of the page's words, each replacing its default (a Record already holds only the keys it is given). */
  words?: BookingWords;
  api_base?: string;
};

const WORDS: BookingWords = {
  failed: 'Something went wrong. Try again.',
  email_title: 'Start with your email', email_lead: 'Each question comes next, one at a time. Your answers are saved as you go.', email_label: 'Your email', email_help: 'Your confirmation goes to this address.', email_placeholder: 'you@example.com', continue: 'Continue',
  question_of: 'Question {number} of {count}', answer_label: 'Your answer', next: 'Next', skip: 'Skip', pick_one: 'Pick one.', pick_many: 'Pick every one that fits.', optional: 'You can leave this one empty.',
  time_title: 'Pick a time', time_lead: 'Times are in {zone}. Each session is {minutes} minutes.', open_times: 'Open times', nothing_open: 'Nothing is open in the coming days. Try again later.',
  confirm_title: 'Confirm your time', confirm_lead: '{title}, {minutes} minutes, with a video call.', book: 'Book this time', another: 'Another time', to: 'to',
  booked_title: 'You are booked', booked_lead: '{title}. A confirmation with the video call is sent to your email.', join: 'Join the video call', add_to_calendar: 'Add to calendar', calendar_details: 'Video call: link in your confirmation.',
};

type Next = AskedNext & { kind: 'email' | 'question' | 'slot' | 'confirm' };
type Screen =
  | { kind: 'email' }
  | { kind: 'question'; next: Next }
  | { kind: 'time' }
  | { kind: 'confirm'; slot: Slot }
  | { kind: 'booked'; meetingLink: string | null; slot: Slot };

const fill = (words: string, values: Record<string, unknown>) => words.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const formatter = (timezone: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options });
const dayKey = (iso: string, timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const dayWords = (iso: string, timezone: string) => formatter(timezone, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(iso));
const timeWords = (iso: string, timezone: string) => formatter(timezone, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const zoneWords = (timezone: string) => formatter(timezone, { timeZoneName: 'long' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value ?? timezone;
// The same event as a calendar template link, read from the slot's own instants.
function calendarLinkOf(title: string, details: string, slot: Slot, timezone: string) {
  const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${stamp(slot.startIso)}/${stamp(slot.endIso)}&ctz=${encodeURIComponent(timezone)}&details=${encodeURIComponent(details)}`;
}

function Step({ at, count, progress, title, lead, children }: { at: number; count: number; progress?: string; title: string; lead?: string; children?: React.ReactNode }) {
  return (
    <Container as="section" layout="vertical" gap="lg" width="full" className="max-w-xl text-left" data-booking-step>
      <StepPieces at={at} count={count} label={progress ?? title} />
      {progress ? <Text as="p" variant="label" color="secondary">{progress}</Text> : null}
      <Container layout="vertical" gap="sm" width="full">
        <Text as="h1" variant="heading-xl" color="strong" className="leading-tight text-balance">{title}</Text>
        {lead ? <Text as="p" variant="body" color="secondary">{lead}</Text> : null}
      </Container>
      {children ? <Container layout="vertical" gap="lg" width="full">{children}</Container> : null}
    </Container>
  );
}

function When({ slot, timezone, to }: { slot: Slot; timezone: string; to: string }) {
  return (
    <Container layout="vertical" gap="xs" width="full">
      <Text as="p" variant="heading" color="strong">{dayWords(slot.startIso, timezone)}</Text>
      <Text as="p" weight="medium">{`${timeWords(slot.startIso, timezone)} ${to} ${timeWords(slot.endIso, timezone)}`}</Text>
      <Text as="p" variant="caption" color="muted">{zoneWords(timezone)}</Text>
    </Container>
  );
}

export function View({ page, title, timezone, duration_minutes, questions, words: given, api_base = '/target' }: BookingPageProps) {
  const words = { ...WORDS, ...given };
  const [screen, setScreen] = useState<Screen>({ kind: 'email' });
  const [slots, setSlots] = useState<Slot[]>([]);
  const [value, setValue] = useState('');
  const [answer, setAnswer] = useState<Answer>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [holding, setHolding] = useState(false);
  const attempt = useRef('');
  const count = 1 + questions.length + 2;
  // Each new step opens at the top of the page; the first step stays where the page put it.
  useStepOpensAtTop(screen.kind === 'question' ? `question:${screen.next.position}` : screen.kind);

  const run = async (work: () => Promise<void>) => {
    setError('');
    setSending(true);
    try { await work(); } catch (caught) { setError(caught instanceof Error ? caught.message : words.failed); } finally { setSending(false); }
  };
  const loadDays = async () => {
    const found = await call<{ slots: Slot[] }>(api_base, 'book.slots', words.failed, { attemptId: attempt.current });
    setSlots(found.slots);
    setScreen({ kind: 'time' });
  };
  // The questions are asked without waiting on the network; the times are read once the last answer is kept.
  const asking = useOptimisticForm({
    api_base,
    answerStep: 'book.answer',
    failed: words.failed,
    attempt,
    ui: {
      show: (next, held) => { setValue(''); setAnswer(held); setScreen({ kind: 'question', next: next as Next }); },
      setError,
      setSending,
      after: async next => { if (next?.kind === 'slot') await loadDays(); },
    },
  });
  const startWith = async (email: string) => {
    const started = await call<{ attemptId: string; next: Next; form?: Definition }>(api_base, 'book.start', words.failed, { page, email });
    attempt.current = started.attemptId;
    asking.begin(started.form);
    await asking.goTo(started.next);
  };

  // An email the visitor already gave starts the booking at its first question; a refused one is filled in with the refusal beside it.
  useEffect(() => {
    const given = (new URLSearchParams(window.location.search).get('email') ?? '').trim();
    if (given === '') return;
    setValue(given);
    setSending(true);
    startWith(given)
      .catch(caught => { setValue(given); setError(caught instanceof Error ? caught.message : words.failed); })
      .finally(() => setSending(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendAnswer = (given: Answer) => {
    if (!sending && screen.kind === 'question') asking.send(screen.next.question, given);
  };
  // The time chosen is shown at once with the booking button pending while the step tool holds it; a time taken since the times
  // were read takes the visitor back to the times (without it) with the tool's words.
  const choose = async (slot: Slot) => {
    setError('');
    setHolding(true);
    setScreen({ kind: 'confirm', slot });
    const held = await holdSlot(() => call(api_base, 'book.slot', words.failed, { attemptId: attempt.current, value: slot.startIso }), words.failed);
    setHolding(false);
    if (held.held) return;
    setSlots(open => withoutSlot(open, slot));
    setScreen({ kind: 'time' });
    setError(held.message);
  };
  const alert = error ? <Text as="p" role="alert" variant="body" className="text-destructive-foreground">{error}</Text> : null;

  let body: React.ReactNode = null;
  if (screen.kind === 'email') {
    body = (
      <Step at={0} count={count} title={words.email_title} lead={words.email_lead}>
        <Form onSubmit={(event: React.FormEvent) => { event.preventDefault(); void run(() => startWith(value)); }} className="flex flex-col gap-5">
          <Labelled label={words.email_label} help={words.email_help} error={error || undefined}>
            <Input name="email" type="email" autoComplete="email" placeholder={words.email_placeholder} required size="lg" className="bg-[var(--bg-primary)]" value={value} onChange={event => setValue(event.target.value)} />
          </Labelled>
          <Button type="submit" size="lg" loading={sending} disabled={sending}>{words.continue}</Button>
        </Form>
      </Step>
    );
  } else if (screen.kind === 'question') {
    const { next } = screen;
    const asked = next.question!;
    const required = next.required !== false;
    const number = questions.findIndex(item => item.position === next.position) + 1;
    const draw = controlFor(asked.questionTypeId)?.draw;
    const picks = draw === 'picks' || draw === 'one';
    const help = asked.help ?? (picks ? (asked.multiple ? words.pick_many : words.pick_one) : required ? undefined : words.optional);
    body = (
      <Step at={number} count={count} progress={fill(words.question_of, { number, count: questions.length })} title={next.prompt ?? ''}>
        <Form onSubmit={(event: React.FormEvent) => { event.preventDefault(); sendAnswer(answer); }} className="flex flex-col gap-5">
          <Labelled label={words.answer_label} help={help} error={error || undefined}>
            <AnswerControl id={`book-answer-${next.position}`} label={next.prompt ?? ''} asked={asked} required={required} value={answer} onChange={setAnswer} />
          </Labelled>
          <Container layout="horizontal" gap="sm" className="flex-wrap">
            <Button type="submit" size="lg" loading={sending} disabled={sending || (required && !answered(answer))}>{words.next}</Button>
            {required ? null : <Button type="button" size="lg" variant="outline" disabled={sending} onClick={() => sendAnswer('')}>{words.skip}</Button>}
          </Container>
        </Form>
      </Step>
    );
  } else if (screen.kind === 'time') {
    const byDay = new Map<string, Slot[]>();
    for (const slot of slots) byDay.set(dayKey(slot.startIso, timezone), [...(byDay.get(dayKey(slot.startIso, timezone)) ?? []), slot]);
    const days = [...byDay].map(([date, open]) => ({ date, label: dayWords(open[0].startIso, timezone), options: open.map(slot => ({ value: slot.startIso, label: timeWords(slot.startIso, timezone) })) }));
    body = (
      <Step at={1 + questions.length} count={count} title={words.time_title} lead={fill(words.time_lead, { zone: zoneWords(timezone), minutes: duration_minutes })}>
        {days.length === 0 ? <Text as="p" color="muted">{words.nothing_open}</Text> : (
          <TimeSlotPicker label={words.open_times} days={days} value={null} onChange={startIso => {
            const slot = slots.find(item => item.startIso === startIso);
            if (slot) void choose(slot);
          }} />
        )}
        {alert}
      </Step>
    );
  } else if (screen.kind === 'confirm') {
    const { slot } = screen;
    body = (
      <Step at={count - 1} count={count} title={words.confirm_title} lead={fill(words.confirm_lead, { title, minutes: duration_minutes })}>
        <When slot={slot} timezone={timezone} to={words.to} />
        <Container layout="horizontal" gap="sm" className="flex-wrap">
          <Button type="button" size="lg" loading={holding || sending} disabled={holding || sending} onClick={() => void run(async () => {
            const booked = await call<{ meetingLink: string | null }>(api_base, 'book.confirm', words.failed, { attemptId: attempt.current });
            setScreen({ kind: 'booked', meetingLink: booked.meetingLink, slot });
          })}>{words.book}</Button>
          <Button type="button" size="lg" variant="outline" disabled={sending || holding} onClick={() => setScreen({ kind: 'time' })}>{words.another}</Button>
        </Container>
        {alert}
      </Step>
    );
  } else {
    const { slot, meetingLink } = screen;
    body = (
      <Step at={count} count={count} title={words.booked_title} lead={fill(words.booked_lead, { title })}>
        <When slot={slot} timezone={timezone} to={words.to} />
        <Container layout="horizontal" gap="sm" className="flex-wrap">
          {meetingLink ? <Button size="lg" href={meetingLink}>{words.join}</Button> : null}
          <Button size="lg" variant="outline" href={calendarLinkOf(title, words.calendar_details, slot, timezone)}>{words.add_to_calendar}</Button>
        </Container>
      </Step>
    );
  }
  return (
    <SectionShell paddingY="hero" size="narrow">
      <TextColumn align="center">
        <Container layout="horizontal" justifyContent="center" width="full" className="coss-ui">{body}</Container>
      </TextColumn>
    </SectionShell>
  );
}
