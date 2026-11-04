import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hearingHere } from '../../computer-programs/read-data/program-here.mjs';
import runtime from './narration/runtime.json' with { type: 'json' };
import helperSettings from '../../../harness/take-open-work.json' with { type: 'json' };
import { findingsFor } from '../../../scripts/check-copy.mjs';
import { runHeavyProcess } from '../../process-session/do-work/heavy-work.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const SOURCE_KIND = 'source-composition.voice-script-binding/v1';
const PRODUCER = resolve(ROOT, 'parts/media-composition/do-work/narration/produce.py');

function profile(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.engine !== 'string' || !value.engine.trim()
    || typeof value.voice !== 'string' || !value.voice.trim()
    || typeof value.speed !== 'number' || !Number.isFinite(value.speed) || value.speed <= 0
    || Object.keys(value).some(key => !['engine', 'voice', 'speed'].includes(key))) {
    throw new Error(`${label} must explicitly provide only engine, voice, and positive speed.`);
  }
  return { engine: value.engine, voice: value.voice, speed: value.speed };
}

export function translateSourceComposition(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.narration) || !data.narration.length)
    throw new Error('Input needs ordered narration rows.');
  const voices = data.voices ?? {};
  if (!voices || typeof voices !== 'object' || Array.isArray(voices)) throw new Error('voices must map speaker keys to native profiles.');
  const rootVoice = data.voice == null ? null : profile(data.voice, 'voice');
  if (data.place !== undefined && (typeof data.place !== 'string' || !data.place.trim()))
    throw new Error('place must name a nonempty existing speaker context.');
  const seen = new Set();
  const lines = data.narration.map((row, index) => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim()
      || typeof row.text !== 'string' || !row.text.trim() || typeof row.speaker !== 'string' || !row.speaker.trim())
      throw new Error(`Narration row ${index + 1} needs id, text, and speaker.`);
    if (seen.has(row.id)) throw new Error(`Duplicate narration id at row ${index + 1}.`);
    seen.add(row.id);
    const selected = voices[row.speaker] == null ? rootVoice : profile(voices[row.speaker], `voices.${row.speaker}`);
    if (!selected) throw new Error(`No explicit native voice profile for speaker ${row.speaker}.`);
    return { id: row.id, text: row.text, ...selected };
  });
  const timing = {};
  for (const key of ['gap', 'lead_in', 'tail']) if (data[key] !== undefined) {
    if (!Number.isFinite(data[key]) || data[key] < 0) throw new Error(`${key} must be finite and nonnegative.`);
    timing[key] = data[key];
  }
  const context = data.place === undefined ? {} : { place: data.place };
  return { lines, timing, context, binding: { schema: SOURCE_KIND, ...context, narration: data.narration.map(({ id, text, speaker, role, source_refs }) => ({ id, text, speaker, role, source_refs })) } };
}

export async function authorVoiceScript({ input, outdir, showtime, cwd = ROOT, run = runHeavyProcess, findProgram = hearingHere }) {
  if (showtime !== undefined) throw new Error('An installed Showtime executable is not a source owner; use the adopted narration producer.');
  if (!input || !outdir) throw new Error('Usage: --input PATH --outdir PATH');
  const sourcePath = resolve(cwd, input), sourceRelative = relative(ROOT, sourcePath);
  if (isAbsolute(sourceRelative) || sourceRelative.startsWith('..')) throw new Error('Input must be inside the Trillion repository.');
  const checkedBytes = await readFile(sourcePath);
  const data = JSON.parse(checkedBytes.toString('utf8'));
  const findings = findingsFor(sourceRelative, data, null, { requireOwner: true });
  if (findings.length) throw Object.assign(new Error(`Copy guard refused ${findings.length} finding(s).`), { findings });
  const translated = translateSourceComposition(data);
  const output = resolve(cwd, outdir);
  const nativePath = resolve(output, 'voice-script.json');
  const bindingPath = resolve(output, 'source-binding.json');
  try {
    const previous = JSON.parse(await readFile(bindingPath, 'utf8'));
    if (previous.source_bytes !== checkedBytes.toString('base64')) throw new Error('Output contains another source epoch; use a fresh output directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(output, { recursive: true });
  const nativeBytes = Buffer.from(`${JSON.stringify({ ...translated.timing, ...translated.context, lines: translated.lines }, null, 2)}\n`);
  await writeFile(nativePath, nativeBytes, { flag: 'w' });
  await writeFile(bindingPath, `${JSON.stringify({ ...translated.binding, source_path: sourceRelative, source_bytes: checkedBytes.toString('base64'), native_path: nativePath, state: 'prepared' }, null, 2)}\n`, { flag: 'w' });
  const assertCurrent = async phase => {
    const current = await readFile(sourcePath);
    if (!current.equals(checkedBytes)) {
      await writeFile(bindingPath, `${JSON.stringify({ ...translated.binding, source_path: sourceRelative,
        source_bytes: checkedBytes.toString('base64'), native_path: nativePath, state: 'stale_epoch', stale_at: phase }, null, 2)}\n`);
      throw Object.assign(new Error(`Stale source composition ${phase}; outputs remain recoverable in ${output}.`), { code: 'STALE_SOURCE' });
    }
  };
  await assertCurrent('before producer invocation');
  let checkedAtStart = false;
  const checkAtStart = async () => {
    await assertCurrent('at admitted producer start');
    if (!(await readFile(nativePath)).equals(nativeBytes)) {
      await writeFile(bindingPath, `${JSON.stringify({ ...translated.binding, source_path: sourceRelative,
        source_bytes: checkedBytes.toString('base64'), native_path: nativePath, state: 'stale_epoch', stale_at: 'native script at admitted producer start' }, null, 2)}\n`);
      throw Object.assign(new Error('Derived voice script changed before admitted producer start.'), { code: 'STALE_NATIVE' });
    }
    checkedAtStart = true;
  };
  try {
    const program = findProgram(runtime.programs.map(row => ({ ...row, search_path: [...row.search_path, ...helperSettings.program_paths] })));
    if (!program) throw new Error('No installed local Python runtime satisfies narration dependencies. Nothing was synthesized.');
    await run(program.program, [PRODUCER, 'voice', 'script', nativePath, '-o', output], { cwd, env: { ...program.env, TRILLION_NARRATION_NODE: process.execPath }, timeoutMs: 14400000, onStart: checkAtStart, onStdout: chunk => process.stdout.write(chunk), onStderr: chunk => process.stderr.write(chunk) });
  } catch (error) {
    if (!['STALE_SOURCE', 'STALE_NATIVE'].includes(error.code)) await writeFile(bindingPath, `${JSON.stringify({ ...translated.binding, source_path: sourceRelative,
      source_bytes: checkedBytes.toString('base64'), native_path: nativePath, state: 'producer_failed' }, null, 2)}\n`);
    throw error;
  }
  if (!checkedAtStart) throw new Error('Producer did not perform its admitted start checks.');
  await assertCurrent('after producer execution');
  const timeline = JSON.parse(await readFile(resolve(output, 'timeline.json'), 'utf8'));
  if (!Array.isArray(timeline.lines) || timeline.lines.length !== translated.lines.length || !Number.isFinite(timeline.duration) || timeline.duration <= 0)
    throw new Error('Native producer did not return a valid complete voice timeline.');
  for (const [index, expected] of translated.lines.entries()) {
    const actual = timeline.lines[index];
    if (['id', 'text', 'engine', 'voice', 'speed'].some(key => actual[key] !== expected[key]))
      throw new Error(`Native producer words, order, or voice differ at line ${index + 1}.`);
  }
  const audio = await readFile(resolve(output, 'vo.wav'));
  if (audio.length <= 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Native producer did not return a WAV file.');
  const readback = JSON.parse(await readFile(resolve(output, 'readback.json'), 'utf8'));
  await assertCurrent('after output readback');
  await writeFile(bindingPath, `${JSON.stringify({ ...translated.binding, source_path: sourceRelative, source_bytes: checkedBytes.toString('base64'), native_path: nativePath, state: 'produced_bound', checked_at_admitted_start: checkedAtStart, semantics: 'unknown', listening: 'not performed' }, null, 2)}\n`);
  return { nativePath, bindingPath, output, lineCount: translated.lines.length, duration: timeline.duration,
    copyFindings: 0, checkedAtAdmittedStart: checkedAtStart, nativeWordVoiceBinding: 'matched', readbackSuspects: readback.suspects ?? null,
    semantics: 'not established by lexical or byte checks', listening: 'not performed', authorAcceptance: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => { const i = args.indexOf(name); return i < 0 || !args[i + 1] || args[i + 1].startsWith('--') ? undefined : args[i + 1]; };
  try {
    const result = await authorVoiceScript({ input: value('--input'), outdir: value('--outdir'), showtime: value('--showtime') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
