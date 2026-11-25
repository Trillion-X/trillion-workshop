// tools/ask-questions-sort-answers-follow-up/web/latest-standing-screen-mount.tsx
//
// PURPOSE
//   Where everyone who answered one form stands now, for the form's owner, as a screen module (`mount(element, props)`, the
//   contract of the module kind). On top, one tile per segment with how many people stand in it now; under it, one row per
//   person, newest first: who, the segment they are in, which way they moved since their time before, how many times they
//   answered and when last. A row opens that person's answers over time (answers-over-time-screen-mount) beside it. A list,
//   never a table of columns.
//
//   Design: Time2book's clients (mobbin.com/screens/cbd62408-72e4-4997-97f5-ff18b48b1455: counts on top, one line per person
//   with a status), the learner home's course rows for the row press; parts are the shared Card, Badge, Button (option-row),
//   EmptyState and Skeleton (21st.dev "Leaderboard Table" 30672 anatomy without its columns: place, name, movement).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The rows are read through the records door: the form's segment assignments (by id prefix) and its segment rules. Who
//      may read everyone's is the site's door's decision (its owners), never this screen's.
//   2. Counts, order and movement come from read-data/answers-over-time.mjs latestStandingOf only.
//   3. Every word is read-data/answers-over-time-words.json, each replaceable by the row's `words`. Nothing here writes a row.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Badge, Button, Card, Container, ErrorBoundary, FloatingMaterialFrame, NamedIcon, Text, mountReactSurface } from '../../ui';
import { EmptyState } from '../../ui/show/empty-state';
import { Skeleton } from '../../ui/show/shadcn/skeleton';
import { emitPlaceableSurfaceIntent } from '../../ui/show/placeable-surface-intent/placeable-surface-intent';
import { listRecords } from '#workspace/records-door';
import { latestStandingOf } from '../read-data/answers-over-time.mjs';
import WORDS from '../read-data/answers-over-time-words.json';

type Words = typeof WORDS;
type Input = { form_id?: string; words?: Partial<Words>; floating_frame?: unknown };
type Standing = ReturnType<typeof latestStandingOf>;

const fill = (words: string, values: Record<string, unknown>) => words.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const dateOf = (at: string | null | undefined) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const MOVED = { up: { tone: 'success', icon: 'ArrowUpRight' }, down: { tone: 'warning', icon: 'ArrowDownRight' }, same: { tone: 'neutral', icon: 'ArrowRight' } } as const;

function LatestStanding({ input }: { input: Input }) {
  const words = React.useMemo(() => ({ ...WORDS, ...(input.words ?? {}) }) as Words, [input.words]);
  const formId = input.form_id ?? '';
  const [standing, setStanding] = React.useState<Standing | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let gone = false;
    setFailed(false);
    void (async () => {
      try {
        const [assignments, segmentRules] = await Promise.all([
          listRecords({ type: 'segment-assignment', prefix: `segment-assignment:${formId}:` }),
          listRecords({ type: 'segment-rule' }),
        ]);
        if (!gone) setStanding(latestStandingOf({ formId, assignments, segmentRules }));
      } catch {
        if (!gone) setFailed(true);
      }
    })();
    return () => { gone = true; };
  }, [attempt, formId]);

  const open = (respondentId: string) => emitPlaceableSurfaceIntent({
    title: respondentId,
    packageEntry: { packageName: 'ask-questions-sort-answers-follow-up', entryName: 'answers-over-time-screen-mount' },
    surfaceInput: { form_id: formId, respondent_id: respondentId, ...(input.words ? { words: input.words } : {}) },
  });

  let body: React.ReactNode;
  if (failed) {
    body = <EmptyState tone="error" icon={<NamedIcon name="CloudOff" size="lg" />} title={words.failed} description={words.failed_why} action={words.retry} onAction={() => setAttempt(count => count + 1)} />;
  } else if (!standing) {
    body = (
      <Container layout="vertical" gap="md" width="full" aria-busy="true" aria-label={words.loading}>
        <Skeleton className="h-8 w-64" />
        <Container layout="horizontal" gap="sm" width="full">{[0, 1, 2].map(tile => <Skeleton key={tile} className="h-24 flex-1" />)}</Container>
        {[0, 1, 2, 3].map(row => <Skeleton key={row} className="h-14 w-full" />)}
      </Container>
    );
  } else if (!standing.people.length) {
    body = <EmptyState icon={<NamedIcon name="Users" size="lg" />} title={words.standing_none} description={words.standing_none_why} />;
  } else {
    body = (
      <Container layout="vertical" width="full" className="gap-8">
        <Text as="h1" variant="title" color="strong">{words.standing_title}</Text>
        <Container layout="horizontal" gap="sm" width="full" className="flex-wrap">
          {[...standing.counts].reverse().map(segment => (
            <Card key={segment.id} variant="nested" padding="md" className="min-w-[8rem] flex-1">
              <Container layout="vertical" gap="xs" width="full">
                <Text variant="label" color="secondary">{segment.title}</Text>
                <Text variant="heading-2xl" color="strong" tabular>{segment.count}</Text>
              </Container>
            </Card>
          ))}
        </Container>
        {standing.unplaced ? <Text variant="label" color="secondary">{fill(words.standing_unplaced, { count: standing.unplaced })}</Text> : null}
        <Container as="ul" layout="vertical" gap="xs" width="full" className="list-none">
          {standing.people.map(person => {
            const moved = person.moved ? MOVED[person.moved] : null;
            return (
              <Container as="li" key={person.respondent_id} layout="vertical" gap="none" width="full">
                <Button type="button" variant="ghost" size="option-row" fullWidth onClick={() => open(person.respondent_id)} aria-label={fill(words.open_person, { name: person.respondent_id })} className="items-center gap-4">
                  <Badge variant="neutral" size="lg" className="min-w-10 justify-center">{person.segment?.title ?? words.no_segment}</Badge>
                  <Container layout="vertical" gap="none" flex={1} className="min-w-0">
                    <Text as="span" variant="body" weight="medium" color="strong" truncate>{person.respondent_id}</Text>
                    <Text as="span" variant="label" color="secondary" truncate>
                      {fill(words.standing_row, { sittings: person.sittings === 1 ? words.sittings_one : fill(words.sittings_count, { count: person.sittings }), date: dateOf(person.at) })}
                    </Text>
                  </Container>
                  {moved && person.previous ? (
                    <Badge variant={moved.tone} size="md">
                      <NamedIcon name={moved.icon} size="xs" aria-hidden="true" />
                      {fill(person.moved === 'same' ? words.moved_same : person.moved === 'up' ? words.moved_up : words.moved_down, { from: person.previous.title })}
                    </Badge>
                  ) : null}
                  <NamedIcon name="ChevronRight" size="sm" aria-hidden="true" />
                </Button>
              </Container>
            );
          })}
        </Container>
      </Container>
    );
  }

  return (
    <FloatingMaterialFrame frame={input.floating_frame}>
      <ErrorBoundary zoneName="latest standing">
        <Container layout="vertical" gap="none" width="full" height="full" overflow="y-auto">
          <Container layout="vertical" gap="none" width="full" className="mx-auto max-w-[880px] px-4 py-8 sm:px-8 sm:py-10">
            {body}
          </Container>
        </Container>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export function mount(element: HTMLElement, props: Input = {}) {
  return mountReactSurface(element, <LatestStanding input={props} />);
}
