// parts/ambience/show/voices-panel.tsx
//
// NO PRIOR: searched parts/ambience and parts/ui for a voice or speech-speed setting (only the audio player's 0.5-2x
//   menu), 21st.dev 'playback speed control slider with preset steps' and Mobbin 'audio playback speed picker' (Brink's
//   Playback Speed: the speed large over its steps; Matter and Moonly: preset speeds with a check). The control itself
//   is the shared SpeedControl (parts/ui/show/speed-control).
//
// PURPOSE
//   How Trillion talks, set on the Ambience screen beside the other sound controls: which of the person's voices speaks
//   (their own cloned voice or a voice everyone has), how fast each voice talks from very slow to very fast, and, for
//   each place Trillion speaks (things said out loud, calls, voice messages, podcasts, posts, the car, coaching, or any
//   place they add), a different voice or speed when they want one. Every value is a row of the person's own lists
//   (src/voices.mjs), read through tool:voice-for and written through the lists road, so the Lists screen, an AI and
//   every device that speaks read exactly what is set here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is kept here: every change shows at once and is written to the person's rows once it settles (one write
//      per slider drag), then the rows are read back, so this screen never holds a second copy of a voice or a speed.
//   2. No voice, place or speed is named in this file; they are the person's rows and the shared speed scale.
//   3. Every control is a shared one (SpeedControl, Dropdown, Button, DisclosureSection, Text).
//   4. A plan that does not include Trillion speaking (tool:voice-for refused as PlanNeeded) shows no section at all:
//      nothing here could be heard on that plan, so no refusal is drawn on the Ambience screen.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { PlanNeeded, postJson } from '#workspace/api.ts';
import { putRows, readListRecord } from '#workspace/list-records.ts';
import { Button, Container, DisclosureSection, Dropdown, SpeedControl, Text, type SpeedScale } from '../../ui';
import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';

type Row = { id: string; label?: string; chosen?: string; speed?: number; voice?: string[] };
type HowItSpeaks = { voices: Row[]; places: Row[]; lists: { voices: string; places: string }; chosen_mark: string; scale: SpeedScale };

const VOICE_FOR = 'tool:voice-for';
const CHOSEN_VOICE = '';

const readHow = async (): Promise<HowItSpeaks> =>
  (await postJson<{ answer: HowItSpeaks }>(`/work/api/workshop/send-quietly/${encodeURIComponent(VOICE_FOR)}`, { input: {} })).answer;

type Change = { id: string; values: Record<string, unknown> };

// A list's rows are the records of the row type its list record names (list-records.ts).
const keepRows = async (list: string, rows: Change[]) => putRows(await readListRecord(list), rows);
const SETTLE_MS = 400;

/** The person's voices and places, read once and again after each change they make here. A change shows at once; a
 *  slider being dragged writes once it settles, so one drag is one write. */
function useHowItSpeaks(): [HowItSpeaks | null, string | null, (list: keyof HowItSpeaks['lists'], rows: Change[]) => void, boolean] {
  const [how, setHow] = React.useState<HowItSpeaks | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [notOnPlan, setNotOnPlan] = React.useState(false);
  const waiting = React.useRef(new Map<string, { list: string; change: Change; timer: number }>());
  const read = React.useCallback(() => readHow().then(answer => { setHow(answer); setProblem(null); }, (error: Error) => {
    if (error instanceof PlanNeeded) setNotOnPlan(true);
    else setProblem(errorWords(error, 'Your voice settings could not be read. Try again.'));
  }), []);
  React.useEffect(() => { void read(); }, [read]);
  const keep = React.useCallback((list: keyof HowItSpeaks['lists'], rows: Change[]) => {
    if (!how) return;
    setHow(current => current && ({
      ...current,
      [list]: current[list].map(row => {
        const change = rows.find(item => item.id === row.id);
        return change ? { ...row, ...Object.fromEntries(Object.entries(change.values).map(([key, value]) => [key, value ?? undefined])) } as Row : row;
      }),
    }));
    for (const change of rows) {
      const key = `${list}:${change.id}`;
      const before = waiting.current.get(key);
      if (before) window.clearTimeout(before.timer);
      const merged = { id: change.id, values: { ...(before?.change.values ?? {}), ...change.values } };
      const timer = window.setTimeout(() => {
        waiting.current.delete(key);
        keepRows(how.lists[list], [merged]).then(read, (error: Error) => setProblem(errorWords(error, 'Your voice settings could not be saved. Try again.')));
      }, SETTLE_MS);
      waiting.current.set(key, { list, change: merged, timer });
    }
  }, [how, read]);
  return [how, problem, keep, notOnPlan];
}

export function VoicesPanel() {
  const [how, problem, keep, notOnPlan] = useHowItSpeaks();
  if (notOnPlan) return null;
  if (!how) return problem ? <Text variant="caption" color="muted">{problem}</Text> : null;
  const chosen = how.voices.find(row => row.chosen === how.chosen_mark) ?? null;
  const voiceItems = [
    { value: CHOSEN_VOICE, label: chosen?.label ? `Your chosen voice (${chosen.label})` : 'Your chosen voice' },
    ...how.voices.map(row => ({ value: row.id, label: row.label ?? row.id })),
  ];
  return (
    <DisclosureSection title="How Trillion talks" divider={false}>
      <Container layout="vertical" gap="md">
        {how.voices.length ? (
          <Container layout="horizontal" gap="xs" wrap role="group" aria-label="The voice Trillion speaks in">
            {how.voices.map(row => (
              <Button
                key={row.id}
                variant="outline"
                size="sm"
                active={row.id === chosen?.id}
                onClick={() => keep('voices', how.voices.map(voice => ({ id: voice.id, values: { chosen: voice.id === row.id ? how.chosen_mark : null } })))}
              >
                {row.label ?? row.id}
              </Button>
            ))}
          </Container>
        ) : (
          <Text variant="caption" color="muted">Your voices appear here once your Mac has made one, or after Trillion first speaks.</Text>
        )}
        {how.voices.map(row => (
          <SpeedControl
            key={row.id}
            label={row.label ?? row.id}
            value={row.speed ?? null}
            scale={how.scale}
            onSpeed={speed => keep('voices', [{ id: row.id, values: { speed } }])}
          />
        ))}
        <DisclosureSection title="Each place it speaks" titleLook="caption" collapsible defaultOpen={false}>
          <Container layout="vertical" gap="md">
            {how.places.map(place => {
              const voice = how.voices.find(row => row.id === place.voice?.[0]) ?? chosen;
              return (
              <Container key={place.id} layout="vertical" gap="xs">
                <Dropdown
                  label={place.label ?? place.id}
                  items={voiceItems}
                  value={place.voice?.[0] ?? CHOSEN_VOICE}
                  onValueChange={value => keep('places', [{ id: place.id, values: { voice: value === CHOSEN_VOICE ? null : [value] } }])}
                />
                <SpeedControl
                  label={`${place.label ?? place.id} speed`}
                  description={place.speed === undefined ? 'The voice’s own speed until you set one here' : undefined}
                  value={place.speed ?? voice?.speed ?? null}
                  scale={how.scale}
                  onSpeed={speed => keep('places', [{ id: place.id, values: { speed } }])}
                />
                {place.speed !== undefined ? (
                  <Button variant="ghost" size="xs" onClick={() => keep('places', [{ id: place.id, values: { speed: null } }])}>Use the voice’s own speed</Button>
                ) : null}
              </Container>
              );
            })}
          </Container>
        </DisclosureSection>
        {problem ? <Text variant="caption" color="muted">{problem}</Text> : null}
      </Container>
    </DisclosureSection>
  );
}
