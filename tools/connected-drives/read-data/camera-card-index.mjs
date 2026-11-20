// tools/connected-drives/read-data/camera-card-index.mjs
//
// PURPOSE
//   `tool:read-a-camera-card-index`: the camera's own index of a card on a connected drive, read only, grouped into
//   recording sessions. Each clip's start time and length come from its sidecar (the camera's XML beside the clip), and a
//   session is a run of clips with no gap longer than the gap in read-data/camera-card-index.json. The answer is one seed
//   per session, ready to keep as a row of the person's seeds table. Nothing here writes to the card.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read only: readdir and readFile under the card's index folder. No write, copy, move, delete or child process.
//   2. Only a volume the drives reader lists as connected is read (driveOf, the same check every drive route uses).
//   3. Every name the camera writes and every time or gap is DATA (camera-card-index.json). A card that is not a camera
//      card has no sidecars under its index folder, so it yields zero sessions: a volume appearing is the event, and
//      what it holds decides whether anything is seeded.
//   4. A sidecar that cannot be read or parsed is counted, never guessed at and never silently dropped.
//   5. A seed's id is stable (volume identity and the session's first clip), so keeping the same card again adds nothing
//      that is already kept.
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { driveOf } from './drive-folder.mjs';
import { connectedDrives } from './drives.mjs';

const settings = JSON.parse(readFileSync(new URL('./camera-card-index.json', import.meta.url), 'utf8'));
const fail = message => new Error(message);
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One sidecar's start time and length, or null when it does not carry both. The element and attribute names are DATA. */
export function parseSidecar(text, s = settings) {
  const pick = (element, attribute) => {
    const match = new RegExp(`<${escapeRegExp(element)}\\b[^>]*\\b${escapeRegExp(attribute)}="([^"]*)"`).exec(text);
    return match ? match[1] : null;
  };
  const created = pick(s.creation_element, 'value');
  const frames = Number(pick(s.duration_element, 'value'));
  const rate = Number(pick(s.rate_element, s.rate_attribute)) || s.default_rate;
  const start = created ? new Date(created) : null;
  if (!start || Number.isNaN(start.getTime()) || !Number.isFinite(frames) || frames <= 0 || !(rate > 0)) return null;
  return { start, seconds: frames / rate };
}

/** Group clips (each {name, path, start, seconds}) into sessions: a clip joins the open session when it starts no more
 *  than gapSeconds after that session's latest end. Pure, so the grouping is tested without a card. */
export function groupSessions(clips, gapSeconds) {
  const sorted = [...clips].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const sessions = [];
  for (const clip of sorted) {
    const end = new Date(clip.start.getTime() + clip.seconds * 1000);
    const open = sessions.at(-1);
    if (open && (clip.start - open.end) / 1000 <= gapSeconds) {
      open.clips.push({ ...clip, end });
      if (end > open.end) open.end = end;
    } else {
      sessions.push({ start: clip.start, end, clips: [{ ...clip, end }] });
    }
  }
  return sessions;
}

const iso = date => date.toISOString();

/** The seed one session becomes: its id, its words are "pending" (the transcription arrives later), where it came from,
 *  and its clip list with times. */
export function seedOfSession(session, { volume, identity }) {
  const first = session.clips[0];
  const seconds = session.clips.reduce((sum, clip) => sum + clip.seconds, 0);
  return {
    id: `camera-card:${identity ?? volume}:${first.name}`,
    words: 'pending',
    came_from: { source: 'volume', volume, paths: session.clips.map(clip => clip.path), at: iso(session.start) },
    media: {
      clips: session.clips.map(clip => ({ name: clip.name, path: clip.path, start: iso(clip.start), end: iso(clip.end), seconds: clip.seconds, bytes: clip.bytes, stored_as: null })),
      session: { start: iso(session.start), end: iso(session.end), clip_count: session.clips.length, total_seconds: Math.round(seconds), total_bytes: session.clips.reduce((sum, clip) => sum + (clip.bytes ?? 0), 0) },
    },
    at: iso(session.start),
  };
}

// The file the host's file-event daemon keeps each volume's identity in. It is the same file the volume waiter reads
// (tools/notice-when-something-shows-up, filesystem-volume-attachment.mjs), so one volume gets one id everywhere.
const VOLUME_IDENTITY_FILE = '.fseventsd/fseventsd-uuid';
const IDENTITY_TEXT = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

/** Read one card's index. `devices` is the drives reader's list of connected drives. The volume's identity is read from
 *  the volume itself; the visible name is used only when the volume carries no identity file. */
export async function readCameraCardIndex({ target, devices }, deps = {}) {
  const readdir = deps.readdir ?? (dir => fsp.readdir(dir));
  const readFile = deps.readFile ?? (file => fsp.readFile(file, 'utf8'));
  const sizeOf = deps.sizeOf ?? (file => fsp.stat(file).then(stat => stat.size, () => null));
  const found = await driveOf(target, devices);
  if (!found) {
    // A volume that is not a connected drive (the system disk, a disk image) is not a camera card: nothing is read on it.
    return { volume: { name: path.basename(target), mount: null, identity: null }, index_folder: null, since: settings.since,
      session_gap_seconds: settings.session_gap_seconds, clips_in_range: 0, clips_before_since: 0, sidecars_unreadable: 0,
      sidecars_without_media: 0, sessions: [], reason: 'not on a connected drive' };
  }
  const identity = await readFile(path.join(found.real, VOLUME_IDENTITY_FILE)).then(text => (IDENTITY_TEXT.test(text.trim()) ? text.trim() : null), () => null);
  const folder = path.join(found.real, settings.index_folder);
  let names;
  try {
    names = await readdir(folder);
  } catch {
    // A volume with no camera index folder holds no sessions. That is a true answer, not an error.
    names = [];
  }
  const media = new Set(names);
  const volume = path.basename(found.mount);
  const since = new Date(settings.since);
  const clips = [];
  let before_since = 0, unreadable = 0, without_media = 0;
  for (const name of names.filter(entry => entry.endsWith(settings.sidecar_suffix)).sort()) {
    const clipName = name.slice(0, -settings.sidecar_suffix.length);
    const mediaName = `${clipName}${settings.media_suffix}`;
    if (!media.has(mediaName)) { without_media += 1; continue; }
    let parsed;
    try {
      parsed = parseSidecar(await readFile(path.join(folder, name)), settings);
    } catch {
      parsed = null;
    }
    if (!parsed) { unreadable += 1; continue; }
    if (parsed.start < since) { before_since += 1; continue; }
    // The media file is never read, only its size is asked for: a clip can be tens of gigabytes.
    const mediaPath = path.join(folder, mediaName);
    clips.push({ name: clipName, path: mediaPath, start: parsed.start, seconds: parsed.seconds, bytes: await sizeOf(mediaPath) });
  }
  const sessions = groupSessions(clips, settings.session_gap_seconds).map(session => seedOfSession(session, { volume, identity }));
  return {
    volume: { name: volume, mount: found.mount, identity },
    index_folder: folder,
    since: settings.since,
    session_gap_seconds: settings.session_gap_seconds,
    clips_in_range: clips.length,
    clips_before_since: before_since,
    sidecars_unreadable: unreadable,
    sidecars_without_media: without_media,
    sessions,
    reason: null,
  };
}

/** `tool:read-a-camera-card-index`: the mounted volume's index as sessions, read only. */
export async function readCameraCardIndexTool({ path: target } = {}, _context, deps = {}) {
  if (typeof target !== 'string' || !target) throw fail('Say which volume: its mount, like /Volumes/1TB SSD.');
  return readCameraCardIndex({ target, devices: await connectedDrives(deps) }, deps);
}
