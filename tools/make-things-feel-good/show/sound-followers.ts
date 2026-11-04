// parts/ambience/show/sound-followers.ts
//
// NO PRIOR: searched bitfield-packages show for light sync, hue entertainment, now playing, and parts/ui sound-targets
//   (the shared follower list it fills)
//
// PURPOSE
//   The person's own lights as things that follow the sound (parts/ui/show/sound-signal/sound-targets.ts), and what is
//   playing on their music service, both read from read-data/sound-followers.json: each service is a row naming the
//   quiet Workshop rows to ask (POST /work/api/workshop/send-quietly/<tool>), sent through the person's own connection
//   and kept nowhere. `followLights()` is handed to the shared follower list once by the page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a service, a light or a field of its answer: every one is a row's path or template.
//   2. A service the person has not connected answers with an error and simply has no lights; the list never fails
//      as a whole because one service did.
//   3. The list is read at most once a minute; a send names only what the row's template asks for.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { postJson } from '#workspace/api.ts';
import type { SoundTarget, TargetPaint } from '../../ui/show/sound-signal/sound-targets';
import followers from '../read-data/sound-followers.json';

type Path = Array<string | number>;
type Template = unknown;
type LightRow = {
  id: string;
  label: string;
  plain: string;
  about: string;
  fixed?: Array<{ id: string; label: string; about?: string }>;
  list?: { tool_id: string; input: Record<string, unknown>; items: Path; id: Path; label: Path; keep?: Record<string, Path> };
  every_ms: number;
  set: { tool_id: string; input: Record<string, Template> };
};
type PlayingRow = { id: string; label: string; tool_id: string; input: Record<string, unknown>; title: Path; by: Path; picture: Path; playing: Path };
export type NowPlaying = { service: string; title: string; by: string | null; picture: string | null; playing: boolean };
export type MusicPlace = { id: string; label: string; page: string; picture: string };

const LIGHTS = followers.lights as LightRow[];
const PLAYING = followers.playing as PlayingRow[];

/** The places music plays, as pictures to press. */
export const musicPlaces = followers.music as MusicPlace[];
/** The lights that can follow, in plain words ("LIFX smart bulbs and Govee light strips"). */
export const lightKinds = LIGHTS.map(row => row.plain);
/** The ids of those lights' services, as their rows are titled on Connections. */
export const lightServices = LIGHTS.map(row => row.id);
const LIST_FOR_MS = 60_000;

const at = (value: unknown, path: Path): unknown => path.reduce<unknown>((here, key) => (here && typeof here === 'object' ? (here as Record<string | number, unknown>)[key] : undefined), value);
const askQuietly = async (toolId: string, input: Record<string, unknown>) =>
  (await postJson<{ answer: unknown }>(`/work/api/workshop/send-quietly/${encodeURIComponent(toolId)}`, { input })).answer;

const rgbOf = (hex: string) => {
  const value = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
  return Number.isNaN(value) ? 0xffffff : value;
};
const dim = (rgb: number, by: number) => (((rgb >> 16) & 255) * by) << 16 | (((rgb >> 8) & 255) * by) << 8 | ((rgb & 255) * by);

/** The facts a send can name from one moment of the sound. */
function factsOf(paint: TargetPaint): Record<string, unknown> {
  const rgb = rgbOf(paint.colour);
  return {
    colour: paint.colour,
    rgb,
    lit_rgb: Math.round(dim(rgb, paint.brightness)),
    brightness: paint.brightness,
    percent: Math.max(1, Math.round(paint.brightness * 100)),
    seconds: paint.seconds,
  };
}

/** A row's input template filled from the sound's facts and the light's kept facts. */
function fill(template: Template, paint: Record<string, unknown>, item: Record<string, unknown>): unknown {
  if (Array.isArray(template)) return template.map(entry => fill(entry, paint, item));
  if (!template || typeof template !== 'object') return template;
  const shape = template as Record<string, unknown>;
  const keys = Object.keys(shape);
  if (keys.length === 1 && typeof shape.paint === 'string') return paint[shape.paint];
  if (keys.length === 1 && typeof shape.item === 'string') return item[shape.item];
  if (keys.length === 1 && Array.isArray(shape.join)) return shape.join.map(entry => String(fill(entry, paint, item) ?? '')).join('');
  return Object.fromEntries(keys.map(key => [key, fill(shape[key], paint, item)]));
}

async function lightsOf(row: LightRow): Promise<SoundTarget[]> {
  const items: Array<{ id: string; label: string; about?: string; kept: Record<string, unknown> }> = row.fixed
    ? row.fixed.map(entry => ({ ...entry, kept: { id: entry.id } }))
    : await (async () => {
      const list = row.list!;
      const answered = at(await askQuietly(list.tool_id, list.input), list.items);
      return (Array.isArray(answered) ? answered : []).map(entry => ({
        id: String(at(entry, list.id) ?? ''),
        label: String(at(entry, list.label) ?? at(entry, list.id) ?? row.label),
        kept: Object.fromEntries(Object.entries(list.keep ?? { id: list.id }).map(([name, path]) => [name, at(entry, path)])),
      })).filter(entry => entry.id);
    })();
  return items.map(entry => ({
    id: `${row.id}:${entry.id}`,
    label: entry.label,
    about: entry.about ?? row.about,
    icon: 'Lightbulb',
    every_ms: row.every_ms,
    send: async paint => { await askQuietly(row.set.tool_id, fill(row.set.input, factsOf(paint), entry.kept) as Record<string, unknown>); },
  }));
}

let listed: { at: number; targets: Promise<SoundTarget[]> } | null = null;

/** Every light the person's connected services have, read once a minute at most. */
export function followLights(): Promise<SoundTarget[]> {
  if (listed && Date.now() - listed.at < LIST_FOR_MS) return listed.targets;
  const targets = Promise.all(LIGHTS.map(row => lightsOf(row).catch(() => [] as SoundTarget[]))).then(all => all.flat());
  listed = { at: Date.now(), targets };
  return targets;
}

/** What is playing on the first connected music service that says, or null when none does. */
export async function nowPlaying(): Promise<NowPlaying | null> {
  for (const row of PLAYING) {
    const answer = await askQuietly(row.tool_id, row.input).catch(() => null);
    const title = at(answer, row.title);
    if (typeof title !== 'string' || !title) continue;
    const by = at(answer, row.by);
    const picture = at(answer, row.picture);
    return { service: row.label, title, by: typeof by === 'string' ? by : null, picture: typeof picture === 'string' ? picture : null, playing: at(answer, row.playing) !== false };
  }
  return null;
}
