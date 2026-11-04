// Translate a saved forward-cut composition into Filmcraft's declared MCP commands.
// The generic app-job owner admits Namespace references and keeps one editor session;
// this adapter never reads media, invents a mount path or changes the saved edit.
// Filmcraft uses254016000000ticks/second. file.import, file.newSequence,
// timeline.place and file.saveAs are shared by its0.4.0and0.7.2command owners.
import { sharedReference } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/live-namespace/do-work/shared-file-reference.mjs';

const TICKS = 254016000000;
const IDENTITY = /^1f:[0-9a-f]{64}$/;
const present = value => value != null && (Array.isArray(value) ? value.length > 0 : typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(value));
const command = (id, params) => ({ operation: 'command_run', arguments: { id, params } });
const filename = value => value.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Edit';
const ticks = seconds => {
  const value = Math.round(seconds * TICKS);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('This source time is too large for an exact Filmcraft handoff. Your saved edit has not changed.');
  return value;
};

/** Pure preparation; source names/sizes are supplied later by the account owner. */
export function filmcraftEditJob({ title, edl, captions = [], textOverlays = [], frameRate = 30 } = {}) {
  const segments = edl?.spine?.segments;
  if (!Array.isArray(segments) || !segments.length) throw new Error('This saved edit has no clips. Add clips and save it first.');
  const { width, height } = edl.encode ?? {};
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 16384)) throw new Error('Choose the edit’s frame shape and save it first.');
  if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 120) throw new Error('Choose a supported timeline speed.');
  // Never turn an advanced saved composition into a different, simpler edit.
  const extras = Object.keys(edl).filter(key => !['title', 'encode', 'spine'].includes(key) && present(edl[key]));
  if (present(captions)) extras.push('captions');
  if (present(textOverlays)) extras.push('titles');
  if (Object.keys(edl.spine).some(key => key !== 'segments' && present(edl.spine[key]))) extras.push('transitions');
  if (extras.length) throw new Error('This edit has captions, layers or sound changes that the Filmcraft handoff cannot yet preserve. Your saved edit has not changed.');
  const titleText = typeof title === 'string' && title.trim() ? title.trim() : 'Edit';
  const sources = new Map();
  const cuts = [];
  let elapsed = 0;
  for (const segment of segments) {
    if (!segment || segment.kind !== 'clip' || !IDENTITY.test(segment.source ?? '') || !Number.isFinite(segment.in) || !Number.isFinite(segment.out) || segment.in < 0 || segment.out <= segment.in) throw new Error('Filmcraft needs forward clip cuts with saved source files and valid start and end times.');
    if (Object.keys(segment).some(key => !['kind', 'id', 'source', 'in', 'out', 'space_id', 'item_id'].includes(key) && segment[key] != null)) throw new Error('This clip has speed, framing or effects that the Filmcraft handoff cannot yet preserve. Your saved edit has not changed.');
    const reference = sharedReference(segment);
    const source = JSON.stringify([segment.source, reference?.space_id ?? null, reference?.item_id ?? null]);
    const startFrame = Math.round(elapsed * frameRate);
    elapsed += segment.out - segment.in;
    const endFrame = Math.round(elapsed * frameRate);
    if (endFrame <= startFrame) throw new Error('A cut is shorter than one timeline frame.');
    if (!sources.has(source)) sources.set(source, { identity: segment.source, key: `source-${sources.size}`, ...(reference ?? {}) });
    cuts.push({ source, startFrame, endFrame, inFrame: Math.round(segment.in * frameRate) });
  }
  // Filmcraft runs this ordered setup in the same private editor session. A
  // refused command stops the batch; the final read proves ingest is disabled
  // before any mounted input is imported. Batching preserves the job's original
  // clip capacity under the unchanged operation bound.
  const steps = [{ operation: 'command_batch', arguments: { steps: [
    { id: 'file.newProject', params: { name: titleText } },
    { id: 'project.ingestSettings', params: { enabled: false } },
    { id: 'project.ingestSettings', params: {} },
  ], stop_on_error: true }, expect: { path: 'answer.results.2.result.enabled', is: false } }];
  const imports = new Map();
  for (const [source, { key }] of sources) {
    imports.set(source, steps.length);
    steps.push({ ...command('file.import', { paths: [{ input_file: key }] }), expect: { path: 'answer.errors.length', is: 0 } });
  }
  steps.push(command('file.newSequence', { name: titleText, width, height, fps: frameRate }));
  for (const cut of cuts) steps.push(command('timeline.place', {
    item: { from_step: imports.get(cut.source), path: 'answer.items.0' }, track: 'V1',
    seconds: cut.startFrame / frameRate, insert: false,
    sourceIn: ticks(cut.inFrame / frameRate), duration: ticks((cut.endFrame - cut.startFrame) / frameRate),
  }));
  steps.push(command('file.saveAs', { path: { output_file: 'project' } }));
  if (steps.length > 32 || sources.size + 1 > 32) throw new Error('This edit is larger than one Filmcraft handoff currently accepts. Your saved edit has not changed.');
  return {
    clips: cuts.length, seconds: Math.round(Math.round(elapsed * frameRate) / frameRate * 1000) / 1000,
    job: { app: 'filmcraft', files: {
      inputs: [...sources.values()].map(source => ({ ...source, access: 'namespace' })),
      outputs: [{ key: 'project', name: `${filename(titleText)}.fcproj`, media_type: 'application/json' }],
    }, steps },
  };
}
