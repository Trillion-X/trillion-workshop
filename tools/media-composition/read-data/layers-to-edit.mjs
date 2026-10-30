// tools/media-composition/read-data/layers-to-edit.mjs
//
// PURPOSE
//   The one translation from "layers" (sounds and pictures laid over a video) to the render engine's own edit fields,
//   shared by the web editor's Layers panel and the Workshop tools `tool:mix-sound-layers` and
//   `tool:layer-pictures-over-video`, so a layer means the same thing wherever it was made.
//
//   A sound layer   { file, start, from, to|null, volume, fade_in, fade_out, duck, label? }
//     plays `file` from `from` to `to` (seconds in the file; null = to its end) starting `start` seconds into the video,
//     at `volume` (0..2), fading in and out over `fade_in`/`fade_out` seconds; `duck` lowers it while the video's own
//     sound or any layer that does not duck is heard (music under speech and voice-over).
//   A picture layer { file, kind: "image"|"video", start, from, to, x, y, size, opacity, fade_in?, fade_out?, label? }
//     shows `file` from `start` for `to - from` seconds (a video plays that stretch of itself), `size` wide as a share
//     of the frame (0..1), its centre at `x`,`y` (shares of the frame across and down: 0.5,0.5 is the middle), at
//     `opacity`. Later layers are drawn over earlier ones. The editor's live preview places a layer the same way.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no I/O, no DOM, no engine import. The render engine (do-work/video-compose.mjs) reads the result as
//      `audio_graph.narration`, `image_overlays` / `video_overlays` (with `layer_order`) and `master_loudnorm`.
//   2. A layer whose numbers are not usable is reported by `layerProblems`, never silently dropped or guessed at.
//   3. `label` is the person's own name for a layer (Music, Voice-over, Logo...); nothing here branches on it.

export const MAX_LAYERS = 32;
export const FILE_IDENTITY = /^(1f|12):[0-9a-f]{64}$/;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round3 = value => Math.round(value * 1000) / 1000;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Every reason these layers cannot be rendered, in plain words; empty when they can. */
export function layerProblems({ sounds = [], pictures = [] } = {}) {
  const problems = [];
  if (!Array.isArray(sounds) || !Array.isArray(pictures)) return ['Send sounds and pictures as lists.'];
  if (sounds.length > MAX_LAYERS || pictures.length > MAX_LAYERS) problems.push(`Use up to ${MAX_LAYERS} sounds and ${MAX_LAYERS} pictures.`);
  sounds.forEach((layer, index) => {
    const name = `Sound ${index + 1}`;
    if (!layer || typeof layer !== 'object') { problems.push(`${name} is not a layer.`); return; }
    if (typeof layer.file !== 'string' || !layer.file) problems.push(`${name} needs a file.`);
    if (!finite(layer.start) || layer.start < 0) problems.push(`${name} needs a start of 0 seconds or later.`);
    if (layer.from !== undefined && (!finite(layer.from) || layer.from < 0)) problems.push(`${name} must start at 0 seconds or later in its file.`);
    if (layer.to !== undefined && layer.to !== null && (!finite(layer.to) || layer.to <= (layer.from ?? 0))) problems.push(`${name} must end after it starts.`);
    if (layer.volume !== undefined && (!finite(layer.volume) || layer.volume < 0 || layer.volume > 2)) problems.push(`${name} needs a volume from 0 to 2.`);
    for (const fade of ['fade_in', 'fade_out']) if (layer[fade] !== undefined && (!finite(layer[fade]) || layer[fade] < 0)) problems.push(`${name} needs a fade of 0 seconds or more.`);
  });
  pictures.forEach((layer, index) => {
    const name = `Picture ${index + 1}`;
    if (!layer || typeof layer !== 'object') { problems.push(`${name} is not a layer.`); return; }
    if (typeof layer.file !== 'string' || !layer.file) problems.push(`${name} needs a file.`);
    if (layer.kind !== 'image' && layer.kind !== 'video') problems.push(`${name} must be a picture or a video.`);
    if (!finite(layer.start) || layer.start < 0) problems.push(`${name} needs a start of 0 seconds or later.`);
    if (!finite(layer.from) || layer.from < 0 || !finite(layer.to) || layer.to <= layer.from) problems.push(`${name} needs a length: its end must come after its start.`);
    for (const axis of ['x', 'y', 'opacity']) if (layer[axis] !== undefined && (!finite(layer[axis]) || layer[axis] < 0 || layer[axis] > 1)) problems.push(`${name} needs ${axis === 'opacity' ? 'an opacity' : 'a position'} from 0 to 1.`);
    if (layer.size !== undefined && (!finite(layer.size) || layer.size <= 0 || layer.size > 1)) problems.push(`${name} needs a size above 0 and up to 1.`);
  });
  return problems;
}

/** The engine's sound placements for these sound layers (`audio_graph.narration` entries). */
export function soundsToEdit(sounds = []) {
  return sounds.map(layer => ({
    artifact: layer.file,
    start: round3(Math.max(0, layer.start)),
    in: round3(Math.max(0, layer.from ?? 0)),
    ...(finite(layer.to) ? { out: round3(layer.to) } : {}),
    volume: round3(finite(layer.volume) ? layer.volume : 1),
    ...(finite(layer.fade_in) && layer.fade_in > 0 ? { fade_in: round3(layer.fade_in) } : {}),
    ...(finite(layer.fade_out) && layer.fade_out > 0 ? { fade_out: round3(layer.fade_out) } : {}),
    ...(layer.duck === true ? { duck: true } : {}),
  }));
}

/** The engine's picture overlays for these picture layers, drawn in list order on a frame `frameWidth` pixels wide. */
export function picturesToEdit(pictures = [], { frameWidth }) {
  const image_overlays = [], video_overlays = [];
  pictures.forEach((layer, layer_order) => {
    const width = Math.max(2, Math.round(frameWidth * clamp(finite(layer.size) ? layer.size : 0.3, 0.01, 1) / 2) * 2);
    const place = {
      layer_order,
      start: round3(layer.start),
      end: round3(layer.start + layer.to - layer.from),
      width,
      x: `W*${round3(clamp(finite(layer.x) ? layer.x : 0.5, 0, 1))}-w/2`,
      y: `H*${round3(clamp(finite(layer.y) ? layer.y : 0.5, 0, 1))}-h/2`,
      opacity: round3(clamp(finite(layer.opacity) ? layer.opacity : 1, 0, 1)),
      ...(finite(layer.fade_in) && layer.fade_in > 0 ? { fade_in: round3(layer.fade_in) } : {}),
      ...(finite(layer.fade_out) && layer.fade_out > 0 ? { fade_out: round3(layer.fade_out) } : {}),
    };
    if (layer.kind === 'image') image_overlays.push({ ...place, image_path: layer.file });
    else video_overlays.push({ ...place, source_path: layer.file, in: round3(layer.from), out: round3(layer.to) });
  });
  return { image_overlays, video_overlays };
}

/** The edit fields for a whole set of layers, merged over `edl` (its other sound and picture choices are kept).
 *  `loudness` (LUFS, e.g. -14) evens out the loudness of the finished video. */
export function layersToEdit({ sounds = [], pictures = [], loudness } = {}, { frameWidth, edl = {} } = {}) {
  const fields = {};
  if (sounds.length) fields.audio_graph = { ...(edl.audio_graph ?? {}), narration: [...(edl.audio_graph?.narration ?? []), ...soundsToEdit(sounds)] };
  if (pictures.length) {
    const { image_overlays, video_overlays } = picturesToEdit(pictures, { frameWidth });
    if (image_overlays.length) fields.image_overlays = [...(edl.image_overlays ?? []), ...image_overlays];
    if (video_overlays.length) fields.video_overlays = [...(edl.video_overlays ?? []), ...video_overlays];
  }
  if (finite(loudness)) fields.master_loudnorm = loudness;
  return fields;
}

/** A saved single music bed (`audio_graph.music_bed`) as the sound layer that plays the same way. */
export function soundFromMusicBed(bed) {
  if (!bed || typeof bed !== 'object' || typeof bed.artifact !== 'string') return null;
  const from = finite(bed.trim?.[0]) ? bed.trim[0] : 0;
  const to = finite(bed.trim?.[1]) && bed.trim[1] > from ? bed.trim[1] : null;
  return {
    file: bed.artifact, label: 'Music', start: 0, from, to,
    volume: finite(bed.volume) ? bed.volume : 0.9,
    fade_in: finite(bed.fade_in?.d) ? bed.fade_in.d : 0,
    fade_out: finite(bed.fade_out?.d) ? bed.fade_out.d : 0,
    duck: Boolean(bed.duck),
  };
}

/** Whether every sound and picture an edit lays over its video names a file in the person's files (never a path); a
 *  voice spoken from written words (`tts_text`) names no file. */
export function layerSourcesAreFiles(edl) {
  const named = [
    ...(Array.isArray(edl?.audio_graph?.narration) ? edl.audio_graph.narration.flatMap(row => (row?.artifact === undefined && typeof row?.tts_text === 'string' ? [] : [row?.artifact])) : []),
    ...(edl?.audio_graph?.music_bed ? [edl.audio_graph.music_bed.artifact] : []),
    ...(Array.isArray(edl?.image_overlays) ? edl.image_overlays.map(row => row?.image_path) : []),
    ...(Array.isArray(edl?.video_overlays) ? edl.video_overlays.map(row => row?.source_path) : []),
  ];
  return named.every(value => typeof value === 'string' && FILE_IDENTITY.test(value));
}
