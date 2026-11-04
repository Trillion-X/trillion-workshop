// parts/screen-look/show/look-over-time-screen.tsx
//
// NO PRIOR: searched parts/screen-look show for schedule, time of day, night shift (ScreenLookSurface paints the
//   plan; nothing edits it), and Mobbin 'night shift schedule from to time picker' (Opal's Easy Evening: a From and a
//   To row, each a time, over a rail of the day; macOS Night Shift: Custom schedule from/to with a warmth slider; GitHub Working Hours: a switch over From/To rows;
//   Oura Chronotype: the day drawn as one line with now on it)
//
// PURPOSE
//   "Screen look over the day": the person's plan for how their screen look changes through the day
//   (read-data/look-over-time.ts), shown and changed in one place. At the top a switch turns the plan on; under it
//   the day as a strip of the colours the screen will wear (the background of each look, blended between points) with
//   now marked on it, and what the screen is doing now: wearing one look, moving between two, or held. The starting
//   plans are tiles; each point of the plan is a row (a time, or the sun at this place with minutes before or after,
//   and the look); "Hold this look" keeps the screen as it is until the plan's next point and "Let the plan carry on"
//   lets go; "Use the sun where I am" keeps this device's place to a tenth of a degree so sun points can be placed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every change goes through changeLookPlan, the same check the account tool and the AI's look_over_time use, and
//      is written as the one plan record every device reads; nothing is kept on this device.
//   2. Nothing here names a look, a preset or an anchor: looks are the person's looks, presets and anchors are rows of
//      look-over-time.json.
//   3. One export, `mount(element, { surfaceInput })`, returning how to take the screen down: the module kind's contract.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { useWorkspacePreference, writeWorkspacePreference } from '#workspace-records';
import { Button, ColourStrip, Container, Dropdown, Input, NamedIcon, Switch, Text, errorWords, type DropdownItem } from '../../ui';
import { mountSharedContent } from '../../ui/show/coss/shared-content';
import {
  LOOK_OVER_TIME, LOOK_PLAN_RECORD, blendValue, changeLookPlan, deviceZone, holdEnds, lookAtTime, readLookPlan,
  startOfDay, type LookMoment, type LookPlan, type LookPoint,
} from '../read-data/look-over-time';
import type { EditableScreenLookTheme } from '../read-data/read-editable-screen-look-themes';
import { resolveScreenLookCssVariables } from './ApplyCurrentScreenLook';
import { useScreenLooks } from './use-screen-looks';

const CLOCK_KIND = 'clock';
const STRIP_STEPS = 96;
const DAY_MS = 86_400_000;
const STRIP_LABELS = [0, 6, 12, 18, 24];

const GROUND = LOOK_OVER_TIME.keep_readable.ground;
const groundCache = new WeakMap<EditableScreenLookTheme, string>();
/** The colour a look paints its page with, the same value the page wears. */
const backgroundOf = (look: EditableScreenLookTheme | undefined): string => {
  if (!look) return 'transparent';
  let ground = groundCache.get(look);
  if (ground === undefined) { ground = resolveScreenLookCssVariables(look)[GROUND] ?? 'transparent'; groundCache.set(look, ground); }
  return ground;
};

const timeWords = (instant: number, zone: string) =>
  new Date(instant).toLocaleTimeString([], { timeZone: zone, hour: 'numeric', minute: '2-digit' });

function useMinute(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), LOOK_OVER_TIME.repaint_every_ms);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** One point of the plan: when (a time, or a sun moment with minutes before or after) and which look. */
function PointRow({ point, looks, onPoint, onRemove }: {
  point: LookPoint; looks: DropdownItem[]; onPoint: (point: LookPoint) => void; onRemove: () => void;
}) {
  const kind = 'clock' in point.at ? CLOCK_KIND : point.at.anchor;
  const kinds: DropdownItem[] = [{ value: CLOCK_KIND, label: 'At a time' }, ...LOOK_OVER_TIME.anchors.map(anchor => ({ value: anchor.id, label: anchor.label }))];
  const moment = (next: LookMoment) => onPoint({ ...point, at: next });
  return (
    <Container layout="horizontal" gap="sm" className="flex-wrap items-center">
      <Dropdown size="md" aria-label="When" items={kinds} value={kind} onValueChange={value => moment(value === CLOCK_KIND ? { clock: '21:00' } : { anchor: value, minutes: 0 })} />
      {'clock' in point.at ? (
        <Input aria-label="Time" type="time" value={point.at.clock} onChange={event => { if (event.target.value) moment({ clock: event.target.value.slice(0, 5) }); }} />
      ) : (
        <Input aria-label="Minutes after, or minus for before" placeholder="Minutes after" type="number" value={String(point.at.minutes ?? 0)} onChange={event => moment({ anchor: (point.at as { anchor: string }).anchor, minutes: Number(event.target.value) || 0 })} />
      )}
      <Dropdown size="md" aria-label="Look" items={looks} value={point.look} onValueChange={look => onPoint({ ...point, look })} />
      <Button variant="ghost" size="icon" aria-label="Remove this point" onClick={onRemove}><NamedIcon name="X" /></Button>
    </Container>
  );
}

function LookOverTime() {
  const { looks } = useScreenLooks();
  const plan = readLookPlan(useWorkspacePreference(LOOK_PLAN_RECORD));
  const [problem, setProblem] = React.useState<string | null>(null);
  const now = useMinute();
  const zone = plan?.time_zone ?? deviceZone();
  const lookIds = looks.map(look => look.id);
  const byId = (id: string) => looks.find(look => look.id === id);
  const nameOf = (id: string) => byId(id)?.name ?? id;

  const change = async (edit: Record<string, unknown>) => {
    try {
      const next = changeLookPlan(plan, edit, lookIds);
      await writeWorkspacePreference(LOOK_PLAN_RECORD, next);
      setProblem(null);
    } catch (error) {
      setProblem(errorWords(error, 'That change could not be saved.'));
      throw error;
    }
  };
  const quietly = (edit: Record<string, unknown>) => { void change(edit).catch(() => {}); };
  const points = plan?.points ?? [];
  const setPoints = (next: LookPoint[]) => quietly({ points: next });

  const shown: LookPlan | null = plan && points.length ? { ...plan, on: true, hold: null } : null;
  const dayStart = startOfDay(now, zone);
  const stops = shown ? Array.from({ length: STRIP_STEPS + 1 }, (_, step) => {
    const at = lookAtTime(shown, new Date(dayStart + (step / STRIP_STEPS) * DAY_MS), zone);
    const colour = at ? blendValue(backgroundOf(byId(at.from)), backgroundOf(byId(at.to)), at.t) : backgroundOf(looks[0]);
    return { at: step / STRIP_STEPS, colour };
  }) : [];
  const labels = STRIP_LABELS.map(hour => ({ at: hour / 24, text: timeWords(dayStart + hour * 3_600_000, zone) }));

  const current = lookAtTime(plan, new Date(now), zone);
  const held = current?.held ?? null;
  const nowWords = !plan?.on
    ? 'Off. Your screen keeps the look you picked.'
    : !current
      ? 'On, but no point can be placed today. Add a time, or use the sun where you are.'
      : held
        ? `Holding ${held.kind === 'worn' ? 'the look you picked' : nameOf(current.t < 0.5 ? current.from : current.to)} until ${timeWords(holdEnds(plan, held, zone), zone)}.`
        : current.from === current.to || current.t >= 1
          ? `Now ${nameOf(current.t >= 1 ? current.to : current.from)}, until ${timeWords(current.next.getTime(), zone)}.`
          : `Moving from ${nameOf(current.from)} to ${nameOf(current.to)}, there by ${timeWords(current.next.getTime(), zone)}.`;

  const lookItems: DropdownItem[] = looks.map(look => ({ value: look.id, label: look.name, icon: 'Circle', tint: backgroundOf(look) }));
  const lastLook = points.at(-1)?.look ?? looks[0]?.id ?? '';

  return (
    <Container layout="vertical" height="full" minHeight="0" overflow="y-auto" className="@container">
      <Container layout="vertical" gap="lg" padding="lg" className="mx-auto w-full max-w-[44rem]">
        <Container layout="horizontal" gap="md" className="items-start justify-between">
          <Container layout="vertical" gap="xs">
            <Text variant="heading-md">Screen look over the day</Text>
            <Text variant="body-sm" color="muted">{nowWords}</Text>
          </Container>
          <Switch checked={plan?.on === true} label="Change my screen look over the day" onCheckedChange={on => quietly(on && !points.length ? { preset: LOOK_OVER_TIME.presets[0].id } : { on })} />
        </Container>

        {stops.length ? <ColourStrip stops={stops} mark={(now - dayStart) / DAY_MS} labels={labels} label="Your screen's colour through today" /> : null}

        {plan?.on && current ? (
          held ? (
            <Button variant="outline" doneLabel="Carrying on" onClick={() => change({ hold: null })}>Let the plan carry on</Button>
          ) : (
            <Button variant="outline" doneLabel="Held" onClick={() => change({ hold: { kind: 'frozen', at: new Date().toISOString() } })}>{`Hold this look until ${timeWords(current.next.getTime(), zone)}`}</Button>
          )
        ) : null}

        <Container layout="vertical" gap="sm">
          <Text variant="label">Start from</Text>
          <Container layout="grid" gap="sm" className="grid-cols-1 @[36rem]:grid-cols-3">
            {LOOK_OVER_TIME.presets.map(preset => (
              <Button key={preset.id} variant="outline" active={plan?.preset === preset.id} aria-pressed={plan?.preset === preset.id} className="h-auto flex-col items-start gap-1 whitespace-normal p-3 text-left" onClick={() => change({ preset: preset.id })}>
                <Text variant="body-sm" weight="semibold">{preset.label}</Text>
                <Text variant="caption" color="muted">{preset.about}</Text>
              </Button>
            ))}
          </Container>
        </Container>

        <Container layout="vertical" gap="sm">
          <Text variant="label">Your plan</Text>
          {points.map((point, index) => (
            <PointRow
              key={index}
              point={point}
              looks={lookItems}
              onPoint={next => setPoints(points.map((one, at) => (at === index ? next : one)))}
              onRemove={() => setPoints(points.filter((_, at) => at !== index))}
            />
          ))}
          {points.length < LOOK_OVER_TIME.most_points ? (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setPoints([...points, { at: { clock: '21:00' }, look: lastLook }])}><NamedIcon name="Plus" />Add a point</Button>
          ) : null}
          {problem ? <Text variant="caption" color="error">{problem}</Text> : null}
        </Container>

        <Container layout="vertical" gap="sm">
          <Text variant="label">The sun</Text>
          <Text variant="caption" color="muted">
            {plan?.place
              ? `Sun times are worked out for about ${plan.place.latitude}, ${plan.place.longitude}.`
              : 'Points can follow sunrise and sunset once Trillion knows roughly where you are.'}
          </Text>
          <Container layout="horizontal" gap="sm" className="flex-wrap">
            <Button variant="outline" size="sm" doneLabel="Using the sun here" onClick={() => new Promise<void>((done, failed) => {
              navigator.geolocation.getCurrentPosition(
                position => { change({ place: { latitude: position.coords.latitude, longitude: position.coords.longitude } }).then(done, failed); },
                () => failed(new Error('Your browser did not share where you are.')),
                { maximumAge: 3_600_000, timeout: 15_000 },
              );
            })}>Use the sun where I am</Button>
            {plan?.place ? <Button variant="ghost" size="sm" doneLabel="Forgotten" onClick={() => change({ place: null })}>Forget my place</Button> : null}
          </Container>
          <Text variant="caption" color="muted">{`Times follow ${plan?.time_zone ? plan.time_zone : `this device's time zone (${deviceZone()})`}.`}</Text>
        </Container>
      </Container>
    </Container>
  );
}

export function mount(element: HTMLElement, _props: { surfaceInput?: Record<string, unknown> }): () => void {
  const host = document.createElement('div');
  host.className = 'trillion-look-over-time h-full';
  element.replaceChildren(host);
  mountSharedContent(host, <LookOverTime />);
  return () => { element.replaceChildren(); };
}
