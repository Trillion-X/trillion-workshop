// tools/grade-and-repair-speech-audio/read-data/speech-enhance.mjs (moved from old trillion computer/speech-enhance.mjs)
//
// Purpose
//   Cleans a recording of noise before it is heard and says where the speech is, on this Mac, with interchangeable
//   tiers (computer/speech-enhance.json) chosen by what the Mac can afford. tool:enhance-speech runs it on a recording.
//
// Non-negotiable invariants
//   1. Tiers, filters, models, thresholds and words are DATA; this file names none. A model is a file dropped in
//      `models_folder`; a tier whose model file is missing is passed over, not failed.
//   2. The tier is chosen by cost against the budget and by what ffmpeg here can really do (its filter list is read,
//      not assumed); when nothing fits the answer says why and the recording is returned untouched (`tier: null`).
//   3. The recording is read in place; the cleaned sound is a new file. Speech places come from the sound that was
//      given, as seconds, so they line up with the original.
//   4. In Workshop (F-0478, `enhanceSpeech`, tool:enhance-speech): the recording is read through the run's door into
//      the run's own folder, the program and the models folder are the ones the person granted (input `ffmpeg`,
//      `models_folder`), the cleaned sound is written beside the person's recording, which is never changed, and the
//      run's folder is removed whatever happens.
//
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWholeFile, writeWholeFile } from '../../records-door/read-data/whole-file.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (place, home = os.homedir()) => String(place).replace(/^~(?=\/|$)/, home);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
export const enhanceSettings = () => JSON.parse(readFileSync(path.join(HERE, 'speech-enhance.json'), 'utf8'));

/** The budget in cost units: the DATA number, else this Mac's cores over `cores_over`. */
export const budgetOf = (settings, cores = os.cpus().length) => settings.cpu_budget ?? Math.max(1, Math.floor(cores / settings.cores_over));

/** { tier, why }: the most expensive tier within the budget whose filters exist here and whose model file is present; why when none. */
export function selectTier(settings, { filters = [], budget = budgetOf(settings), exists = existsSync } = {}) {
  const within = settings.tiers.filter(tier => tier.cost <= budget).sort((a, b) => b.cost - a.cost);
  if (!within.length) return { tier: null, why: fill(settings.words.over_budget, { budget }) };
  const missing = [];
  for (const tier of within) {
    const lacking = (tier.needs_filters ?? []).filter(name => !filters.includes(name));
    if (tier.model_file && !exists(path.join(expand(settings.models_folder), tier.model_file))) lacking.push(tier.model_file);
    if (!lacking.length) return { tier, why: null };
    missing.push(...lacking);
  }
  return { tier: null, why: fill(settings.words.missing_needs, { needs: [...new Set(missing)].join(', ') }) };
}

/** The ffmpeg words for a tier over `input` into `output`. */
export const commandFor = (settings, tier, input, output) => settings.run.map(word => fill(word, {
  input, output, filter: fill(tier.filter, { model: tier.model_file ? path.join(expand(settings.models_folder), tier.model_file) : '' }),
}));

/** Speech places [{ start, end }] in seconds from ffmpeg's silencedetect output and the recording's length. */
export function speechPlaces(text, seconds, least = 0.25) {
  const silences = []; let open = null;
  for (const line of String(text).split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line); const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (start) open = Math.max(0, Number(start[1]));
    if (end && open !== null) { silences.push([open, Number(end[1])]); open = null; }
  }
  if (open !== null) silences.push([open, seconds]);
  const places = []; let at = 0;
  for (const [from, to] of silences) { if (from - at >= least) places.push({ start: at, end: from }); at = to; }
  if (seconds - at >= least) places.push({ start: at, end: seconds });
  return places;
}

const runProgram = (argv, search, seconds = 600) => new Promise((resolve, reject) => {
  const env = { ...process.env, PATH: [...search.map(expand), process.env.PATH].join(path.delimiter) };
  execFile(argv[0], argv.slice(1), { env, timeout: seconds * 1000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve({ stdout: String(stdout), stderr: String(stderr) })));
});

/** The ffmpeg filter names on this Mac. */
export async function filtersHere(settings, run = runProgram) {
  const { stdout } = await run(['ffmpeg', '-hide_banner', '-filters'], settings.search_path);
  return stdout.split('\n').map(line => /^\s*[A-Za-z.]{1,3}\s+(\S+)/.exec(line)?.[1]).filter(Boolean);
}

/** Cleans `input` into `output` with the chosen tier and finds its speech: { tier, why, output, speech }. */
export async function enhance({ input, output, settings = enhanceSettings(), run = runProgram, budget }) {
  const filters = await filtersHere(settings, run).catch(() => []);
  const { tier, why } = selectTier(settings, { filters, budget });
  // ffmpeg with only an input prints the recording's length and then stops with an error: the length is read from what it said.
  const heard = await run(['ffmpeg', '-nostdin', '-i', input], settings.search_path).catch(error => error);
  const length = Number(/Duration:\s*(\d+):(\d+):([\d.]+)/.exec(heard.stderr ?? '')?.slice(1).reduce((total, part, index) => total + Number(part) * [3600, 60, 1][index], 0)) || 0;
  const source = tier ? output : input;
  if (tier) await run(commandFor(settings, tier, input, output), settings.search_path);
  const scan = await run(settings.vad_run.map(word => fill(word, { input: source, noise: settings.vad.noise_db, seconds: settings.vad.least_silence_seconds })), settings.search_path);
  return { tier: tier?.id ?? null, why, output: tier ? output : null, speech: speechPlaces(scan.stderr, length, settings.vad.least_speech_seconds) };
}

export const enhanceTools = {
  /** { path, output? } -> { tier, why, output, speech: [{ start, end }] } */
  async enhance(input) {
    const settings = enhanceSettings();
    if (!String(input.path ?? '').trim()) throw Object.assign(new Error(settings.words.needs_input), { status: 400 });
    const file = expand(input.path);
    return enhance({ input: file, output: input.output ? expand(input.output) : file.replace(/(\.\w+)?$/, '.clean.wav'), settings });
  },
};

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** The budget a request asks for: a whole number 1..64, else this computer's own (budgetOf). */
export function budgetAsked(asked, settings) {
  if (asked == null) return budgetOf(settings);
  if (!Number.isInteger(asked) || asked < 1 || asked > 64) throw fail(settings.words.bad_budget);
  return asked;
}

/** The cleaned file's name beside the recording: `<name>.clean.wav`. */
export const cleanedName = name => String(name).replace(/(\.[A-Za-z0-9]+)?$/, '.clean.wav');

/** The settings of one request: the models folder the person granted (none: a tier naming a model file is passed
 *  over), and the granted ffmpeg found first by its folder. */
export function settingsFor(input, settings = enhanceSettings()) {
  const program = String(input?.ffmpeg ?? '').trim();
  const models = input?.models_folder ?? settings.models_folder;
  return { ...settings, models_folder: models, tiers: models ? settings.tiers : settings.tiers.filter(tier => !tier.model_file),
    search_path: program.includes('/') ? [path.dirname(program)] : settings.search_path };
}

/**
 * tool:enhance-speech: { file, ffmpeg?, models_folder?, cpu_budget?, output? } -> { tier, why, budget, file, output, speech }.
 * The recording is read through the door into the run's own folder; when a tier ran, the cleaned sound is written beside
 * it in the person's files (`output`, default `<name>.clean.wav`). `steps.enhance` replaces the ffmpeg work for tests.
 */
export async function enhanceSpeech(input, { door }, steps = {}) {
  const settings = settingsFor(input);
  if (!String(input?.file ?? '').trim()) throw fail(settings.words.needs_input);
  const budget = budgetAsked(input.cpu_budget, settings);
  const { title, size, bytes } = await readWholeFile(door, input.file);
  if (!bytes) throw fail(fill(settings.words.too_large, { file: input.file, size }));
  const folder = mkdtempSync(path.join(os.tmpdir(), 'enhance-'));
  try {
    const source = path.join(folder, `in${path.extname(title) || '.wav'}`);
    const cleaned = path.join(folder, 'out.wav');
    writeFileSync(source, bytes, { mode: 0o600 });
    const done = await (steps.enhance ?? enhance)({ input: source, output: cleaned, settings, budget });
    const output = done.output ? String(input.output ?? cleanedName(input.file)) : null;
    if (output) await writeWholeFile(door, output, readFileSync(cleaned), { mediaType: 'audio/wav' });
    return { ...done, budget, file: input.file, output };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
