// tools/ask-questions-sort-answers-follow-up/web/answers-over-time-screen-mount.tsx
//
// PURPOSE
//   One person's answers to one form over every time they answered it, as a screen module (its single export,
//   `mount(element, props)`, is the contract of the module kind, workspace-screens web/src/workspace/tool-screen.tsx). One
//   column, one thing at a time from the top: where they stand now (the segment, what it means, which way they moved, one
//   "answer it again" press), what to do next (the segment's follow-up), each time they answered (a timeline with the segment
//   and how many answers changed), what changed since last time (each changed question, before and now, a numeric question as
//   its trend), and every answer behind one fold per question. Never a table of columns.
//
//   Design: Codecademy's benchmark result (mobbin.com/screens/fc2dd380-28af-4459-95ba-a21396c65286: the level, what it means,
//   "take it again to check your progress"), Bevel's progression (mobbin.com/screens/9d4d8735-053b-4e9c-a425-67bc0289f889:
//   now against then, dated), stoic.'s history (mobbin.com/screens/230d0508-5fc0-4d4f-a04c-e678cbfba791: each entry dated with
//   its answers); parts are the shared Timeline (21st.dev changelog timeline 36570 anatomy), Sparkline, Card, Badge,
//   DisclosureSection, EmptyState and Skeleton.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The rows are read through the records door: the form (question-sequence), the answer facts and segment assignments of
//      one person (by id prefix), the segment rules and follow-up sequences. Which person is the row's `respondent_id`, else
//      the host's `subject_email`; the site's door decides what that person may read, never this screen.
//   2. Everything shown comes from read-data/answers-over-time.mjs; nothing here scores, ranks or names a segment.
//   3. Every word is read-data/answers-over-time-words.json, each replaceable by the row's `words`. "Answer it again" goes to
//      the row's `answer_at` (the address that asks the form). Nothing here writes a row.
//   4. A row with `show_segments: false` draws no segment, move or follow-up (the owner has not said yes to them yet): the
//      sittings, the changes and every answer are drawn the same.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Badge, Button, Card, Container, DisclosureSection, ErrorBoundary, FloatingMaterialFrame, NamedIcon, Text, Timeline, mountReactSurface } from '../../ui';
import { EmptyState } from '../../ui/show/empty-state';
import { Skeleton } from '../../ui/show/shadcn/skeleton';
import { Sparkline } from '../../ui/show/sparkline/Sparkline';
import { listRecords, readRecord } from '#workspace/records-door';
import { answersOverTime } from '../read-data/answers-over-time.mjs';
import WORDS from '../read-data/answers-over-time-words.json';

type Words = typeof WORDS;
type Input = {
  form_id?: string;
  respondent_id?: string;
  subject_email?: string;
  answer_at?: string;
  show_segments?: boolean;
  words?: Partial<Words>;
  floating_frame?: unknown;
};
type Model = ReturnType<typeof answersOverTime>;
type Line = Model['questions'][number];
type Segment = NonNullable<NonNullable<Model['latest']>['segment']>;

const fill = (words: string, values: Record<string, unknown>) => words.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const dateOf = (at: string | null | undefined) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const MOVED_TONE = { up: 'success', down: 'warning', same: 'neutral' } as const;

function movedWords(words: Words, moved: string | null, from: Segment | null | undefined) {
  if (!moved || !from) return null;
  return fill(moved === 'up' ? words.moved_up : moved === 'down' ? words.moved_down : words.moved_same, { from: from.title });
}

function changedWords(words: Words, count: number) {
  return count === 0 ? words.changed_none : count === 1 ? words.changed_one : fill(words.changed_count, { count });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Container as="section" layout="vertical" gap="md" width="full" aria-label={title}>
      <Text as="h2" variant="heading" color="strong">{title}</Text>
      {children}
    </Container>
  );
}

function Loading({ words }: { words: Words }) {
  return (
    <Container layout="vertical" width="full" className="gap-10" aria-busy="true" aria-label={words.loading}>
      <Container layout="vertical" gap="sm" width="full">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-4 w-3/4" />
      </Container>
      {[0, 1, 2].map(row => <Skeleton key={row} className="h-16 w-full" />)}
    </Container>
  );
}

/** One question's answer before and now; a numeric question also as the trend of every answer it has had. */
function Change({ line, words }: { line: Line; words: Words }) {
  return (
    <Card variant="nested" padding="md">
      <Container layout="vertical" gap="sm" width="full">
        <Text as="h3" variant="body" weight="medium" color="strong" className="text-pretty">{line.label}</Text>
        {line.numeric ? (
          <Container layout="horizontal" gap="md" alignItems="end" width="full">
            <Sparkline points={line.answers.map(answer => ({ value: Number(answer.value), label: `${dateOf(answer.at)}: ${answer.words}` }))} height="sm" className="max-w-40" />
            <Text variant="heading-lg" color="strong" tabular>{line.before?.words ?? words.not_answered} → {line.now?.words ?? words.not_answered}</Text>
          </Container>
        ) : (
          <Container layout="vertical" gap="xs" width="full">
            <Text variant="label" color="secondary">{words.before} · {dateOf(line.before?.at)}</Text>
            <Text as="p" variant="body" color="secondary" className="whitespace-pre-line text-pretty">{line.before?.words || words.not_answered}</Text>
            <Text variant="label" color="secondary" className="pt-2">{words.now} · {dateOf(line.now?.at)}</Text>
            <Text as="p" variant="body" color="strong" className="whitespace-pre-line text-pretty">{line.now?.words || words.not_answered}</Text>
          </Container>
        )}
      </Container>
    </Card>
  );
}

function AnswersOverTime({ input }: { input: Input }) {
  const words = React.useMemo(() => ({ ...WORDS, ...(input.words ?? {}) }) as Words, [input.words]);
  const formId = input.form_id ?? '';
  const respondentId = input.respondent_id ?? input.subject_email ?? '';
  const [model, setModel] = React.useState<Model | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let gone = false;
    setFailed(false);
    void (async () => {
      try {
        const [form, facts, assignments, segmentRules, followUps] = await Promise.all([
          readRecord(`question-sequence:${formId}`, 'question-sequence'),
          listRecords({ type: 'answer-fact', prefix: `answer-fact:${formId}:${respondentId}:` }),
          listRecords({ type: 'segment-assignment', prefix: `segment-assignment:${formId}:${respondentId}` }),
          listRecords({ type: 'segment-rule' }),
          listRecords({ type: 'follow-up-sequence' }),
        ]);
        const shown = answersOverTime({ form: form as never, facts, assignments, segmentRules, followUps, respondentId });
        if (!gone) setModel(shown);
      } catch {
        if (!gone) setFailed(true);
      }
    })();
    return () => { gone = true; };
  }, [attempt, formId, respondentId]);

  const answerAgain = input.answer_at ? () => window.location.assign(input.answer_at!) : undefined;
  let body: React.ReactNode;
  if (failed) {
    body = <EmptyState tone="error" icon={<NamedIcon name="CloudOff" size="lg" />} title={words.failed} description={words.failed_why} action={words.retry} onAction={() => setAttempt(count => count + 1)} />;
  } else if (!model) {
    body = <Loading words={words} />;
  } else if (!model.latest) {
    body = <EmptyState icon={<NamedIcon name="ClipboardList" size="lg" />} title={words.none} description={words.none_why} action={answerAgain ? words.start : undefined} onAction={answerAgain} />;
  } else {
    const latest = model.latest;
    const segments = input.show_segments !== false;
    const moved = segments ? movedWords(words, model.moved, model.previous?.segment) : null;
    body = (
      <Container layout="vertical" width="full" className="gap-10">
        <Container layout="vertical" gap="sm" width="full">
          {model.title ? <Text variant="label" color="secondary" weight="medium">{model.title}</Text> : null}
          <Text as="h1" variant="display" color="strong" className="text-balance">{segments ? latest.segment?.title ?? words.no_segment : words.answers_title}</Text>
          {segments && latest.segment?.meaning ? <Text as="p" variant="body-lg" color="secondary" className="text-pretty">{latest.segment.meaning}</Text> : null}
          <Container layout="horizontal" gap="sm" alignItems="center" className="flex-wrap pt-1">
            {moved ? <Badge variant={MOVED_TONE[model.moved as keyof typeof MOVED_TONE]} size="lg">{moved}</Badge> : segments || !model.previous ? <Badge size="lg">{words.first_time}</Badge> : null}
            <Text variant="label" color="secondary">{fill(words.sitting_of, { date: dateOf(latest.at) })} · {(model.sittings.length === 1 ? words.sittings_one : fill(words.sittings_count, { count: model.sittings.length }))}</Text>
          </Container>
          {answerAgain ? (
            <Container layout="horizontal" gap="sm" className="pt-3">
              <Button type="button" variant="primary" size="lg" onClick={answerAgain}>
                <NamedIcon name="RotateCcw" size="md" aria-hidden="true" />
                {words.again}
              </Button>
            </Container>
          ) : null}
        </Container>

        {segments && (model.follow_up.length || latest.segment?.next_step) ? (
          <Section title={words.next_steps}>
            <Container as="ol" layout="vertical" gap="xs" width="full" className="list-none">
              {latest.segment?.next_step ? (
                <Container as="li" layout="horizontal" gap="sm" alignItems="start" width="full">
                  <NamedIcon name="ArrowRight" size="sm" aria-hidden="true" />
                  <Text variant="body" color="strong">{latest.segment.next_step}</Text>
                </Container>
              ) : null}
              {model.follow_up.map(step => (
                <Container as="li" key={step.id} layout="horizontal" gap="sm" alignItems="start" width="full">
                  <NamedIcon name="ArrowRight" size="sm" aria-hidden="true" />
                  <Text variant="body" color="strong">{step.label}</Text>
                </Container>
              ))}
            </Container>
          </Section>
        ) : null}

        <Section title={words.changes}>
          {!model.previous ? (
            <Text as="p" variant="body" color="secondary">{words.baseline}</Text>
          ) : model.changes.length ? (
            <Container layout="vertical" gap="sm" width="full">
              {model.changes.map(line => <Change key={line.id} line={line} words={words} />)}
            </Container>
          ) : (
            <Text as="p" variant="body" color="secondary">{words.changes_none}</Text>
          )}
        </Section>

        <Section title={words.sittings}>
          <Timeline
            items={[...model.sittings].reverse().map(sitting => ({
              id: sitting.id || 'one',
              time: dateOf(sitting.at),
              title: segments ? sitting.segment?.title ?? words.no_segment : words.no_segment,
              detail: [(segments ? movedWords(words, sitting.moved, model.sittings[model.sittings.indexOf(sitting) - 1]?.segment) : null) ?? (model.sittings.indexOf(sitting) ? null : words.first_time),
                model.sittings.indexOf(sitting) ? changedWords(words, sitting.changed) : null].filter(Boolean).join(' · '),
            }))}
          />
        </Section>

        <Section title={words.all_answers}>
          <Container layout="vertical" gap="none" width="full">
            {model.questions.map(line => (
              <DisclosureSection key={line.id} title={line.label} headingLevel={3} collapsible defaultOpen={false} titleLook="caption">
                <Timeline items={[...line.answers].reverse().map((answer, index) => ({ id: `${line.id}:${answer.sitting}:${index}`, time: dateOf(answer.at), title: answer.words || words.not_answered }))} />
              </DisclosureSection>
            ))}
          </Container>
        </Section>
      </Container>
    );
  }

  return (
    <FloatingMaterialFrame frame={input.floating_frame}>
      <ErrorBoundary zoneName="answers over time">
        <Container layout="vertical" gap="none" width="full" height="full" overflow="y-auto">
          <Container layout="vertical" gap="none" width="full" className="mx-auto max-w-[760px] px-4 py-8 sm:px-8 sm:py-10">
            {body}
          </Container>
        </Container>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mount(element: HTMLElement, props: Input = {}) {
  return mountReactSurface(element, <AnswersOverTime input={props} />);
}
