// tools/ask-questions-sort-answers-follow-up/show/FormPage.tsx
//
// PURPOSE
//   A form asked one question at a time, one thing on the screen at a time: what the form is, each question, then the result
//   (the segment the form's rules give and what to do next) and, for a visitor, keeping the answers with their email. A
//   signed-in person answers as themselves and their result is kept as it is shown. The program says what comes next, so the
//   screen draws the step it is given and reports each answer; it asks nothing itself.
//
// NON-NEGOTIABLE INVARIANTS
//   1. View is pure: no fetch, no window and no storage while it renders. The host owns the sitting (which step, the answer
//      being typed, the email, the error, whether a send is under way) and passes it in as props; every press is reported
//      through a callback (onStart, onResume, onChange, onSend, onEmailChange, onKeep).
//   2. Every word is `info.words` (the form's own row); the screen holds no words of its own. The step in view is the host's
//      `screen`; a loading screen draws nothing.
//   3. The step's controls are the shared ones of ./FormSteps.tsx; nothing here writes markup of its own.
//   4. A step says where the person is as one plain line of progress under the bar ("Question 2 of 5"), never as a small
//      label over the heading.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Container } from '../../ui/show/container/index.ts';
import { Text } from '../../ui/show/text/Text.tsx';
import { Form } from '../../ui/show/form/Form.tsx';
import { ProgressBar } from '../../ui/show/progress-bar/ProgressBar.tsx';
import { Input } from '../../ui/show/coss/ui/input.tsx';
import { Button } from '../../ui/show/coss/ui/button.tsx';
import { SectionShell, TextColumn } from '../../ui/show/marketing-page/MarketingPagePrimitives.tsx';
import { AnswerControl, Labelled, answered, type Answer, type Next } from './FormSteps.tsx';
import { controlFor } from '../read-data/step-controls.ts';

export type Words = Record<string, string | undefined>;
export type PageInfo = { title: string | null; words: Words; questions: number; keep_on: string | null; signed_in: boolean };
export type Result = { segment: { id: string; title: string; meaning: string | null; next_step: string | null } | null; follow_up: { id: string; label: string }[]; kept: boolean; keep_at: string | null };
export type Screen =
  | { kind: 'loading' }
  | { kind: 'closed'; message: string }
  | { kind: 'intro'; resumable: boolean }
  | { kind: 'question'; next: Next }
  | { kind: 'result'; result: Result };

export type FormPageProps = {
  screen: Screen;
  info: PageInfo | null;
  answer?: Answer;
  email?: string;
  error?: string;
  sending?: boolean;
  onStart?: () => void;
  onResume?: () => void;
  onChange?: (value: Answer) => void;
  onSend?: (value: Answer) => void;
  onEmailChange?: (email: string) => void;
  /** Called with the email when the visitor asks to keep the answers; the host takes them through its sign-in. */
  onKeep?: (email: string) => void;
};

const fill = (words: string | undefined, values: Record<string, unknown>) => (words ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));

// A step, flat on the page: how far along, its heading and words, then what the step asks.
function Step({ done, progress, title, lead, children }: { done: number; progress?: string; title: string; lead?: string; children?: React.ReactNode }) {
  return (
    <Container as="section" layout="vertical" gap="lg" width="full" className="max-w-xl text-left" data-form-step>
      <ProgressBar percentage={Math.round(done * 100)} color="var(--button-primary-bg)" height="0.25rem" aria-label={progress ?? title} />
      {progress ? <Text as="p" variant="label" color="secondary" data-form-progress>{progress}</Text> : null}
      <Container layout="vertical" gap="sm" width="full">
        <Text as="h1" variant="heading-xl" color="strong" className="leading-tight text-balance">{title}</Text>
        {lead ? <Text as="p" variant="body" color="secondary" className="text-pretty">{lead}</Text> : null}
      </Container>
      {children ? <Container layout="vertical" gap="lg" width="full">{children}</Container> : null}
    </Container>
  );
}

function Alert({ error }: { error: string }) {
  return error ? <Text as="p" role="alert" variant="body" className="text-destructive-foreground">{error}</Text> : null;
}

function Body({ screen, info, answer = null, email = '', error = '', sending = false, onStart, onResume, onChange, onSend, onEmailChange, onKeep }: FormPageProps) {
  if (screen.kind === 'loading') return null;
  if (screen.kind === 'closed') return <Step done={0} title={screen.message} />;
  if (!info) return null;
  const words = info.words;

  if (screen.kind === 'intro') {
    return (
      <Step done={0} title={words.intro_title ?? info.title ?? ''} lead={fill(words.intro_lead, { count: info.questions })}>
        <Container layout="horizontal" gap="sm" className="flex-wrap">
          {screen.resumable ? <Button type="button" size="lg" disabled={sending} onClick={() => onResume?.()}>{words.resume}</Button> : null}
          <Button type="button" size="lg" variant={screen.resumable ? 'outline' : 'default'} disabled={sending} onClick={() => onStart?.()}>{screen.resumable ? words.start_over : words.start}</Button>
        </Container>
        <Alert error={error} />
      </Step>
    );
  }

  if (screen.kind === 'question') {
    const { next } = screen;
    const asked = next.question!;
    const required = next.required !== false;
    const draw = controlFor(asked.questionTypeId)?.draw;
    const picks = draw === 'picks' || draw === 'one';
    const place = (next.position ?? 0) + 1;
    const help = asked.help ?? (picks ? (asked.multiple ? words.pick_many : words.pick_one) : required ? undefined : words.optional);
    const submit = (event: React.FormEvent) => { event.preventDefault(); onSend?.(answer); };
    return (
      <Step done={place / (info.questions + 1)} progress={fill(words.question_of, { number: place, count: info.questions })} title={next.prompt ?? ''}>
        <Form onSubmit={submit} className="flex flex-col gap-5">
          <Labelled label={words.answer_label ?? ''} help={help} error={error || undefined}>
            <AnswerControl id={`form-answer-${next.position}`} label={next.prompt ?? ''} asked={asked} required={required} value={answer} onChange={value => onChange?.(value)} textPlaceholder={words.answer_placeholder} />
          </Labelled>
          <Container layout="horizontal" gap="sm" className="flex-wrap">
            <Button type="submit" size="lg" loading={sending} disabled={sending || (required && !answered(answer))}>{words.next}</Button>
            {required ? null : <Button type="button" size="lg" variant="outline" disabled={sending} onClick={() => onSend?.('')}>{words.skip}</Button>}
          </Container>
        </Form>
      </Step>
    );
  }

  const { result } = screen;
  const steps = [result.segment?.next_step, ...result.follow_up.map(step => step.label)].filter((step): step is string => Boolean(step));
  const keep = (event: React.FormEvent) => { event.preventDefault(); onKeep?.(email.trim()); };
  return (
    <Step done={1} title={result.segment?.title ?? words.result_title ?? ''} lead={result.segment?.meaning ?? undefined}>
      {steps.length ? (
        <Container layout="vertical" gap="sm" width="full">
          <Text as="h2" variant="heading" color="strong">{words.next_steps}</Text>
          <Container as="ol" layout="vertical" gap="xs" width="full" className="list-decimal pl-5">
            {steps.map(step => <Container as="li" key={step} className="list-item"><Text variant="body" color="strong">{step}</Text></Container>)}
          </Container>
        </Container>
      ) : null}
      {result.kept ? (
        <Container layout="vertical" gap="md" width="full">
          <Text as="p" variant="body" color="secondary">{words.kept_lead}</Text>
          {result.keep_at ? <Container layout="horizontal"><Button size="lg" href={result.keep_at}>{words.open_kept}</Button></Container> : null}
          <Alert error={error} />
        </Container>
      ) : (
        <Form onSubmit={keep} className="flex flex-col gap-5">
          <Container layout="vertical" gap="xs" width="full">
            <Text as="h2" variant="heading-lg" color="strong">{words.keep_title}</Text>
            <Text as="p" variant="body" color="secondary">{words.keep_lead}</Text>
          </Container>
          <Labelled label={words.email_label ?? ''} help={words.email_help} error={error || undefined}>
            <Input id="form-keep-email" name="email" type="email" autoComplete="email" placeholder={words.email_placeholder} required size="lg" className="bg-[var(--bg-primary)]" value={email} onChange={event => onEmailChange?.(event.target.value)} />
          </Labelled>
          <Container layout="horizontal"><Button type="submit" size="lg">{words.keep_button}</Button></Container>
        </Form>
      )}
    </Step>
  );
}

export function View(props: FormPageProps) {
  return (
    <SectionShell paddingY="hero" size="narrow">
      <TextColumn align="center">
        <Container layout="horizontal" justifyContent="center" width="full" className="coss-ui">
          <Body {...props} />
        </Container>
      </TextColumn>
    </SectionShell>
  );
}
