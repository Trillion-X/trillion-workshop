#!/usr/bin/env node
/**
 * file: parts/media-composition/do-work/cut-the-action.mjs
 *
 * PURPOSE: Cut a recording down to the moments where something happens and render the result. It only ASSEMBLES existing owners:
 * a detector row of cut-by-events.json finds the events (detect-events.mjs; the program row is find-action-moments.mjs), the rules of
 * cut-by-events.json turn them into KEPT RANGES over the original (cut-by-events.mjs over src/range-edits.mjs, with the second-stage
 * models of src/confidence-filter.mjs, the devices of a src/session-pairing.mjs session and the frame of src/frame-calibration.mjs),
 * and render-an-edit.mjs renders them. The work runs as named stages of video-pipeline.mjs, so it has a report that says honestly
 * where it is, can be shown while it works, and continues from the first unfinished stage after a stop (--resume).
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Blind: no sport, event kind or detector is named here; --detector names a row of cut-by-events.json.
 * 2. Removal only: the rendered video is made of ranges of the recording; the length is measured and must match the kept total.
 * 3. An uncertain event is not silently kept or dropped: the answer lists it as asked or abstained, with the words that say why.
 * 4. A local-model detector row is asked through --ask-model-command (a program that reads {job, request} on standard input and
 *    prints {events}); without it the row refuses in words.
 *
 * Usage: node cut-the-action.mjs --video <file> --output <file.mp4> [--detector <id>] [--models <json file of second-stage rows>]
 *          [--session <json file: { id, states, messages }>] [--corners <json: four [x, y] corners>] [--runs <home folder of the run reports>]
 *          [--ask-model-command <program>] [--upload-command <program: called with part number, offset, length and the file; exit 0 confirms the part>]
 *          [--transcript <json: { words: [{ text, start, end }] }> cut by removal of fillers and long pauses instead of by events]
 *          [--segments <json: { ready: [states], segments: [{ start, end, state }] }> pieces the render needs, e.g. a person matte; the render waits until they cover every kept range]    or    node cut-the-action.mjs --resume <run id> [--runs <home folder>]
 * Prints the report of the run as JSON on its last line.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkOutputLength, refuseUntilReady } from '../../../src/range-edits.mjs';
import { apply, newSession } from '../../../src/session-pairing.mjs';
import { calibrate } from '../../../src/frame-calibration.mjs';
import { cutByEvents, editFor } from './cut-by-events.mjs';
import { detectEvents } from './detect-events.mjs';
import { measureVideo, renderEdl } from './render-an-edit.mjs';
import { makeVideoPipeline, uploadInParts } from './video-pipeline.mjs';
import pipelineConfig from './video-pipeline.json' with { type: 'json' };

const argument = (name, argv) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const json = file => JSON.parse(readFileSync(file, 'utf8'));

/** The numbers a second-stage model may weigh for an event: its own numeric fields and the gaps to its neighbours. */
export const featuresOf = (event, index, events) => ({
  ...Object.fromEntries(Object.entries(event).filter(([, value]) => typeof value === 'number')),
  gap_before: index > 0 ? event.time - events[index - 1].time : 0,
  gap_after: index < events.length - 1 ? events[index + 1].time - event.time : 0,
});

/** The session a list of pair-state messages leaves, with the messages that were ignored and why. */
export function sessionOf({ id, states, messages = [] }) {
  let session = newSession(id, states);
  const ignored = [];
  for (const message of messages) { const step = apply(session, message); session = step.session; if (step.ignored) ignored.push(step.ignored); }
  return { session, ignored };
}

/** Runs (or resumes) the cut. `askModel(job, request)` answers a local-model detector row. */
// depends_on_lane: visual-content. Cuts from a transcript (words, fillers, long pauses) belong to auto-edit.mjs; it is imported when a
// transcript is given, and `wordCuts({ words, duration }) -> { kept }` can be handed in for a test or another owner.
const autoEditCuts = async () => {
  try { return (await import('./auto-edit.mjs')).cutTranscript; }
  catch { throw Object.assign(new Error('Cutting from a transcript needs auto-edit.mjs, which is not here yet.'), { retry: false }); }
};

export async function cutTheAction({ video, output, detector = 'sound-and-motion', models = [], session = null, corners = null, askModel, upload = null, transcript = null, wordCuts = null, segments = null, runs, resume = null, tolerance = 0.6 }) {
  if (resume) ({ video, output, detector } = { ...{ video, output, detector }, ...makeVideoPipeline({ ...(runs ? { home: runs } : {}) }).replay(resume).input });
  let sentSoFar = null;
  const handlers = {
    detect: async () => {
      const { duration_seconds: duration } = measureVideo(video);
      return { duration, events: transcript ? [] : await detectEvents({ detector, video, from: 0, to: duration, askModel }) };
    },
    cut: async ({ results, plan }) => {
      const frame = corners ? (await calibrate({ detect: async () => ({ corners, confidence: 1 }), min_confidence: 0.5 })).h : null;
      const cut = transcript ? await (wordCuts ?? await autoEditCuts())({ words: transcript.words ?? [], duration: results.detect.duration }) : cutByEvents({ duration: results.detect.duration, events: results.detect.events, models, featuresOf, session: session ? sessionOf(session).session : null, frame });
      plan('proposed', cut.kept);
      return cut;
    },
    render: async ({ results, plan }) => {
      if (!results.cut.kept.length) throw Object.assign(new Error(results.cut.said || 'Nothing was kept.'), { retry: false });
      if (segments) refuseUntilReady(results.cut.kept, segments.segments, segments.ready, 'the pieces this render needs');
      const { edl } = editFor({ baseArtifact: video, kept: results.cut.kept, encode: {} });
      plan('applied', edl.spine.segments);
      const made = renderEdl(edl, output);
      const length = checkOutputLength(results.cut.kept, made.duration_seconds, tolerance);
      if (!length.ok) throw new Error(`The video is ${made.duration_seconds} s long but the cut promised ${length.expected} s.`);
      return { file: output, ...made, length };
    },
    // Only with an upload command: the video is sent in numbered parts, and the file is freed from this Mac only after every part is confirmed.
    finalize_render: async ({ input }) => { rmSync(input.output, { force: true }); return {}; },
    upload: async ({ stage, results }) => {
      const sent = await uploadInParts({ size: statSync(results.render.file).size, part_size: upload.part_size ?? pipelineConfig.part_size, previous: sentSoFar ?? stage.result,
        send: async (number, offset, length) => spawnSync(upload.command, [String(number), String(offset), String(length), results.render.file]).status === 0 });
      sentSoFar = sent;
      if (!sent.confirmed) throw new Error(`${sent.parts.filter(part => part.state !== 'confirmed').length} of ${sent.total} parts are not confirmed.`);
      return sent;
    },
    free_local: async ({ results }) => { rmSync(results.render.file, { force: true }); return { freed: true }; },
  };
  const pipeline = makeVideoPipeline({ handlers, ...(runs ? { home: runs } : {}) });
  return resume ? pipeline.resume(resume) : pipeline.start({ pipeline: upload ? 'cut-to-events' : 'cut-to-file', input: { video, output, detector } });
}

/** The Mac host's tool: { video, output, detector?, models?, session?, corners?, transcript?, segments?, resume? } -> the run report (state, stages, kept ranges, measured file). */
export const cutTools = {
  async cut(input = {}) {
    if (!input.resume && (typeof input.video !== 'string' || typeof input.output !== 'string')) throw Object.assign(new Error('Name the video to cut and the file to write.'), { status: 400, retry: false });
    return cutTheAction({ ...input, runs: input.runs ?? join(homedir(), '.trillion', 'cut-runs') });
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const command = argument('ask-model-command', argv);
  try {
    const report = await cutTheAction({
      video: argument('video', argv), output: argument('output', argv), detector: argument('detector', argv),
      transcript: argument('transcript', argv) ? json(argument('transcript', argv)) : null, segments: argument('segments', argv) ? json(argument('segments', argv)) : null,
      models: argument('models', argv) ? json(argument('models', argv)) : [], session: argument('session', argv) ? json(argument('session', argv)) : null,
      corners: argument('corners', argv) ? JSON.parse(argument('corners', argv)) : null, runs: argument('runs', argv), resume: argument('resume', argv),
      upload: argument('upload-command', argv) ? { command: argument('upload-command', argv), part_size: Number(argument('part-size', argv)) || undefined } : null,
      askModel: command ? async (job, request) => JSON.parse(execFileSync(command, [], { input: JSON.stringify({ job, request }), encoding: 'utf8' })) : undefined,
    });
    console.log(JSON.stringify(report));
    process.exitCode = report.state === 'done' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
