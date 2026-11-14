// parts/ui/show/catch-up/TwoVersions.tsx
//
// PROVENANCE
//   Field by field, each version in its own column, the person picking per field what the kept record holds:
//   Salesforce's Compare leads (a pick on every field row, mobbin.com/screens/5dc154a3-7f3d-4869-8a5d-1398d85fb0ca) and
//   Front's Review your merge (a conflicting field offers each value to swap in, the rest kept as they are,
//   mobbin.com/screens/0ecf2195-42d2-4db8-a7c4-46a176759c17). The three ways out (keep one, keep both, merge) follow
//   Air's duplicate choice (mobbin.com/screens/ac2d76ce-872c-4bfc-959f-38c97719f1c1) without its dialog: the view opens
//   in place where the record is listed. Long words show their changes with the shared DiffView. Written fresh; no code
//   was copied.
//
// PURPOSE
//   Any record kept as two (or more) versions because copies changed it apart, shown so the person sees exactly what
//   differs and settles it in one press: keep one version, keep both as separate things, or keep a merged version made
//   of the value they picked for each field that differs. Fields that are the same are counted, not repeated.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Works for any record kind and any value: an object is its fields, anything else is one value; nothing here
//      names a kind or a field.
//   2. Every way out is a button that says its own work (pending, done, Try again); settling goes to the source that
//      kept the versions (settleKeptApart), which keeps every version until it answers.
//   3. Merge is offered only when the picks take something from more than one version; until the person picks, each
//      field starts on the version marked current.
//   4. Two columns when the view has room (container query in screen-look/show/catch-up.css), one stacked list on a
//      phone; nothing scrolls sideways.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { lazyPart } from '../load-later/later';
import * as React from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { NamedIcon } from '../icon';
import { Text } from '../text';
import { relativeWhen } from '../relative-time/relative-time';
import { plainWords, settleKeptApart, type CatchUpWords, type KeptSide, type ShownApart } from './catch-up';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const shown = (value: unknown): string => (value === undefined || value === null ? '' : typeof value === 'string' ? value : Array.isArray(value) ? value.map(shown).join('\n') : typeof value === 'object' ? JSON.stringify(value) : String(value));
const fill = (template: string | undefined, values: Record<string, string>) => (template ?? '').replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole);
// Words long enough that a line-by-line difference reads better than two blocks side by side.
const LONG_WORDS = 160;
// The line-by-line difference is fetched only when long words need it, so a menu that never shows it never loads it.
const LineDifference = lazyPart(() => import('../diff-view'), module => ({ before, after }: { before: string; after: string }) => <module.DiffView lines={module.computeUnifiedDiff(before, after)} maxHeight={220} />);

/** The fields every version has between them, in the order they first appear (invariant 1). */
export function fieldsOf(sides: readonly KeptSide[]): string[] {
  if (!sides.every(side => isRecord(side.value))) return [''];
  const keys: string[] = [];
  for (const side of sides) for (const key of Object.keys(side.value as Record<string, unknown>)) if (!keys.includes(key)) keys.push(key);
  return keys;
}
const valueAt = (side: KeptSide, field: string) => (field === '' ? side.value : (side.value as Record<string, unknown>)[field]);

/** The merged value: the current version, with each picked field taken from the version picked for it. */
export function mergedValue(sides: readonly KeptSide[], picks: Readonly<Record<string, string>>): unknown {
  const base = sides.find(side => side.current) ?? sides[0];
  if (!isRecord(base.value)) return valueAt(sides.find(side => side.id === picks['']) ?? base, '');
  const merged: Record<string, unknown> = { ...(base.value as Record<string, unknown>) };
  for (const [field, sideId] of Object.entries(picks)) {
    const side = sides.find(candidate => candidate.id === sideId);
    if (!side || !isRecord(side.value)) continue;
    if (field in side.value) merged[field] = side.value[field];
    else delete merged[field];
  }
  return merged;
}

export function TwoVersions({ apart, words, onSettled }: { apart: ShownApart; words: CatchUpWords; onSettled?: () => void }) {
  const sides = apart.sides;
  const current = (sides.find(side => side.current) ?? sides[0]).id;
  const fields = React.useMemo(() => fieldsOf(sides), [sides]);
  const differing = fields.filter(field => new Set(sides.map(side => shown(valueAt(side, field)))).size > 1);
  const same = fields.length - differing.length;
  const [picks, setPicks] = React.useState<Record<string, string>>(() => Object.fromEntries(differing.map(field => [field, current])));
  const mixed = new Set(Object.values(picks)).size > 1;
  const now = Date.now();
  const settle = (how: Parameters<typeof settleKeptApart>[1]) => settleKeptApart(apart, how).then(() => { onSettled?.(); });
  const say = (key: string, values: Record<string, string> = {}) => fill(words.words[key], values);
  const single = fields.length === 1 && fields[0] === '';
  const longText = single && sides.length === 2 && sides.some(side => shown(side.value).length > LONG_WORDS);

  return (
    <Container layout="vertical" gap="md" className="catch-up-versions" data-catch-up-versions="" data-sides={sides.length} data-single={single || undefined}>
      <Container layout="vertical" gap="xs">
        <Text variant="body" weight="semibold">{apart.thing.title}</Text>
        <Text variant="caption">{say('changed_apart', { count: String(differing.length) })}</Text>
      </Container>

      <Container layout="vertical" gap="sm" data-catch-up-fields="" role="group" aria-label={say('pick_each')}>
        <Container layout="horizontal" gap="sm" data-catch-up-columns="" aria-hidden>
          {single ? null : <Text variant="caption" data-catch-up-field-name="" />}
          {sides.map(side => (
            <Container key={side.id} layout="horizontal" gap="xs" alignItems="center" data-catch-up-side-head="">
              <NamedIcon name="MonitorSmartphone" size="sm" color="faint" />
              <Text variant="label" weight="medium" truncate>{side.from}</Text>
              {side.at !== undefined ? <Text variant="caption" truncate>{relativeWhen(side.at, now)}</Text> : null}
            </Container>
          ))}
        </Container>
        {(single ? [''] : differing).map(field => (
          <Container key={field || 'value'} layout="horizontal" gap="sm" data-catch-up-field="">
            {single ? null : <Text variant="label" weight="medium" data-catch-up-field-name="">{plainWords(field)}</Text>}
            {sides.map(side => {
              const picked = (picks[field] ?? current) === side.id;
              const value = shown(valueAt(side, field));
              return (
                <Button
                  key={side.id}
                  size="option-row"
                  variant="plain"
                  data-catch-up-pick=""
                  data-picked={picked || undefined}
                  aria-pressed={picked}
                  work={null}
                  onClick={() => setPicks(before => ({ ...before, [field]: side.id }))}
                >
                  <NamedIcon name={picked ? 'CircleCheck' : 'Circle'} size="sm" />
                  <Text variant="body-xs" wrap="preserve" data-catch-up-value="" data-empty={value ? undefined : ''}>{value || words.words.empty}</Text>
                  <Text variant="caption" data-catch-up-pick-from="">{side.from}</Text>
                </Button>
              );
            })}
          </Container>
        ))}
        {!single && same > 0 ? <Text variant="caption">{say(same === 1 ? 'same_one' : 'same_many', { count: String(same) })}</Text> : null}
        {longText ? <React.Suspense fallback={null}><LineDifference before={shown(sides[0].value)} after={shown(sides[1].value)} /></React.Suspense> : null}
      </Container>

      <Container layout="horizontal" gap="sm" wrap="wrap" data-catch-up-ways="">
        {sides.map(side => (
          <Button key={side.id} size="sm" variant={side.id === current ? 'primary' : 'secondary'} errorLabel={words.words.try_again}
            data-catch-up-keep={side.id} onClick={() => settle({ keep: 'one', side: side.id })}>
            {side.keep ?? say('keep_side', { from: side.from })}
          </Button>
        ))}
        <Button size="sm" variant="secondary" errorLabel={words.words.try_again} data-catch-up-keep-both="" onClick={() => settle({ keep: 'both' })}>
          <NamedIcon name="Copy" size="sm" />{words.words.keep_both}
        </Button>
        {mixed ? (
          <Button size="sm" variant="secondary" errorLabel={words.words.try_again} data-catch-up-merge="" onClick={() => settle({ keep: 'merged', value: mergedValue(sides, picks) })}>
            <NamedIcon name="GitMerge" size="sm" />{words.words.merge}
          </Button>
        ) : null}
      </Container>
    </Container>
  );
}
