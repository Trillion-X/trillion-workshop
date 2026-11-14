// parts/feel/show/FeelSettings.tsx
//
// NO PRIOR: searched bitfield-packages/packages/*/show for "haptic", "sound settings" and "feedback settings"
// (none). References (anatomy; original code): Mobbin Tide Guide alert sound picker and Comet voice settings (each row
// plays itself from a play button beside its name), Breathwrk customization (sound and vibration each a choice with
// Off), Strava Audio Cues and Garmin Audio Prompts (one switch row per event).
//
// PURPOSE
//   Feel, a section of Look: how each moment feels, for the person to try and change. At the top one switch per output
//   (Touch, Sound, Motion) for every moment at once; then a row per moment with a play button that plays it now, the
//   feel it plays (any feel row, or Nothing), and the outputs it plays on. Every change is one of the person's show
//   rules (subject feel), the same record a rule made in Settings or by their AI is kept in, so it follows them to every
//   device and their AI can read and change it (read_show_rules, set_show_rule).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The moments, feels and outputs are records/feel-moments.json's; nothing here names one.
//   2. A switch shows what the rules say now (showOf), so a rule from anywhere (a quiet night on the phone) shows here.
//      Switching one off keeps a silence rule with a known id; switching it on takes that rule away.
//   3. Choosing a feel keeps one change rule per moment (set feel); choosing the moment's own feel takes it away.
//   4. Every control is a shared part (parts/ui); this file writes no markup and no appearance.

import * as React from 'react';
import { Play } from 'lucide-react';
import { Button, Card, Container, Dropdown, Switch, Text } from '../../ui';
import { removeShowRule, saveShowRule, showChanged, showOf, useShowChange } from '../../ui/show/show-rules/show-of';
import { tryFeel, type FeelRows } from './mount-feel';

const SUBJECT = 'feel';
const choice = (field: string, values: string[]) => ({ kind: 'rule', field, operator: 'is_any_of', params: { values } });
const all = (...rules: unknown[]) => ({ kind: 'group', combinator: 'and', negate: false, rules });
const quietId = (output: string, moment?: string) => (moment ? `feel-quiet-${moment}-${output}` : `feel-quiet-${output}`);
const changeId = (moment: string) => `feel-change-${moment}`;
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

type Moment = FeelRows['moments'][number];

function plays(moment: Moment, output: string): boolean {
  const thing = showChanged(SUBJECT, { moment: moment.id, feel: moment.feel, output });
  const answer = showOf(SUBJECT, thing);
  return !answer.hidden && !answer.silenced;
}

function feelNow(moment: Moment): string {
  const thing = showChanged(SUBJECT, { moment: moment.id, feel: moment.feel, output: '' });
  return typeof thing.feel === 'string' ? thing.feel : moment.feel;
}

async function setPlays(rows: FeelRows, output: string, on: boolean, moment?: Moment): Promise<void> {
  const id = quietId(output, moment?.id);
  if (on) { await removeShowRule(id).catch(() => {}); return; }
  const outputLabel = rows.outputs.find(row => row.id === output)?.label ?? output;
  await saveShowRule({
    id, subject: SUBJECT, effect: 'silence', by: 'person', time_zone: zone(),
    label: moment ? `${outputLabel} off: ${moment.label}` : `${outputLabel} off everywhere`,
    when: moment ? all(choice('moment', [moment.id]), choice('output', [output])) : all(choice('output', [output])),
  });
}

async function setFeel(rows: FeelRows, moment: Moment, feel: string): Promise<void> {
  if (feel === moment.feel) { await removeShowRule(changeId(moment.id)).catch(() => {}); return; }
  await saveShowRule({
    id: changeId(moment.id), subject: SUBJECT, effect: 'change', by: 'person', time_zone: zone(),
    label: `${moment.label} feels like ${rows.feels[feel]?.label ?? feel}`,
    when: all(choice('moment', [moment.id])), set: [{ path: ['feel'], value: feel }],
  });
}

function MomentRow({ rows, moment, redraw, readRows }: { rows: FeelRows; moment: Moment; redraw: () => void; readRows?:()=>Promise<FeelRows> }) {
  const play = React.useRef<HTMLDivElement>(null);
  const feel = feelNow(moment);
  const outputs = rows.outputs.filter(output => rows.feels[feel]?.[output.id]);
  return (
    <Container ref={play} layout="horizontal" gap="md" alignItems="center" padding="md" wrap data-feel-moment={moment.id}>
      <Button size="icon" variant="ghost" aria-label={`Feel ${moment.label.toLowerCase()}`}
        onClick={() => { return (readRows?readRows():Promise.resolve(rows)).then(current=>{const selected=current.moments.find(row=>row.id===moment.id);if(!selected)return;const now=feelNow(selected);tryFeel(current,now,play.current,current.outputs.filter(output=>current.feels[now]?.[output.id]&&plays(selected,output.id)).map(output=>output.id));}).catch(error=>{console.warn('Feel rows could not be read.',error);throw error;}); }}>
        <Play className="h-4 w-4" aria-hidden="true" />
      </Button>
      <Container layout="vertical" gap="xs" flex={1}>
        <Text variant="body" weight="semibold">{moment.label}</Text>
      </Container>
      <Dropdown aria-label={`How ${moment.label.toLowerCase()} feels`} value={feel}
        items={Object.entries(rows.feels).map(([id, row]) => ({ value: id, label: row.label }))}
        onValueChange={next => { void setFeel(rows, moment, next).then(redraw); }} />
      <Container layout="horizontal" gap="sm" alignItems="center">
        {outputs.map(output => (
          <Container key={output.id} layout="horizontal" gap="xs" alignItems="center" data-feel-output={output.id}>
            <Switch size="sm" label={`${output.label}: ${moment.label}`} checked={plays(moment, output.id)}
              onCheckedChange={on => { void setPlays(rows, output.id, on, moment).then(redraw); }} />
            <Text variant="caption" color="muted">{output.label}</Text>
          </Container>
        ))}
      </Container>
    </Container>
  );
}

/** Feel: every moment's touch, sound and motion, to try and change. `rows` is records/feel-moments.json. */
export function FeelSettings({ rows, readRows }: { rows: FeelRows; readRows?:()=>Promise<FeelRows> }) {
  useShowChange();
  const [, redraw] = React.useReducer((count: number) => count + 1, 0);
  const everywhere = (output: string) => {
    const answer = showOf(SUBJECT, { moment: '', feel: '', output });
    return !answer.hidden && !answer.silenced;
  };
  return (
    <Container layout="vertical" gap="sm" data-feel-settings="">
      <Card variant="surface" padding="none">
        <Container layout="horizontal" gap="lg" alignItems="center" padding="md" wrap>
          {rows.outputs.map(output => (
            <Container key={output.id} layout="horizontal" gap="sm" alignItems="center" data-feel-output={output.id}>
              <Switch size="sm" label={`${output.label} everywhere`} checked={everywhere(output.id)}
                onCheckedChange={on => { void setPlays(rows, output.id, on).then(redraw); }} />
              <Text variant="body" weight="semibold">{output.label}</Text>
            </Container>
          ))}
        </Container>
      </Card>
      <Card variant="surface" padding="none">
        {rows.moments.map(moment => <MomentRow key={moment.id} rows={rows} moment={moment} redraw={redraw} readRows={readRows} />)}
      </Card>
    </Container>
  );
}
