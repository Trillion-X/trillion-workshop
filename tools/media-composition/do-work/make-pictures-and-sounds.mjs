#!/usr/bin/env node
/**
 * file: parts/media-composition/do-work/make-pictures-and-sounds.mjs
 *
 * PURPOSE: The one runner behind every "make" tool (tool:make-<style>): it reads one style row from
 * make-pictures-and-sounds.json and turns it into new files: a thumbnail about the video, a striking picture of the
 * person from frames of their recording, a frame enhanced, a pencil portrait, a cut-out, a cut-out placed on a new
 * background, a sound effect, music, a sound effect made on the person's own computer by a local model or by physical
 * synthesis. It knows four kinds of input (a recording and a moment, a line of text, a number or a list of them, another
 * style's result) and two kinds of maker (an http request that answers with base64 bytes, a program run here, once per
 * result or, when the maker says `makes_all`, once for every result into one folder); every model, prompt, count, key
 * location and command is a row. What differs per computer (a program's path, a weights folder) is the person's
 * settings, given at run time with --settings, over the maker's and the style's own.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. A key is read from the file its maker's connection is placed at (the tool row's credential_mounts), sent only in
 *    the request header or query its maker names, and never written to a file, argument, output or error. With no
 *    key placed, a maker that names `through_trillion` sends the same request through the relay file placed at
 *    --relay (the Workshop's relay for this run: { url, person, key }), and Trillion's gateway account pays; its key
 *    is likewise sent only in the relay's own header and never written anywhere.
 * 2. The recording is never written. Every result is a new file in the output folder, written under a partial name
 *    and renamed once complete; a result of the wrong kind is converted to the kind the style makes (media_type).
 * 3. A style made from other styles (made_from) runs each of them once first, into a working folder, and keeps only
 *    its own results; a style may not depend on itself, directly or through others.
 * 4. Nothing here names a style, a maker, a service or a model.
 *
 * Usage: node do-work/make-pictures-and-sounds.mjs --style <style id> [--out <folder>] [--work <folder>] [--relay <file>] [--settings <file>] < input.json
 *   input.json is the tool's input: { video?, at?, <text, number and list fields>..., count? } (the style's input_schema).
 *   --settings is a JSON object of the person's settings for this computer, laid over the maker's and the style's.
 * Output (stdout, last line, JSON): { style, makes, count, made: [{ name, media_type, bytes }], failed: [{ error }] }
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve as absolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bestPosterTime } from './pick-poster-frame.mjs';

const MAX_COUNT = 12;
const MAX_DEPTH = 4;
const here = dirname(fileURLToPath(import.meta.url));
const plain = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// The end of a program's complaint is where it says what went wrong.
const tail = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(-max);
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg' };

/** The style and maker rows, by id (the address's last part). */
export function readMakeRows(file = join(here, 'make-pictures-and-sounds.json')) {
  const things = JSON.parse(readFileSync(file, 'utf8')).things ?? [];
  const byKind = kind => new Map(things.filter(thing => thing?.payload?.kind === kind).map(thing => [String(thing.address).split('::').pop(), thing.payload]));
  const styles = byKind('media-generation-style');
  const makers = byKind('media-maker');
  for (const [id, style] of styles) {
    if (!makers.has(style.maker)) throw new Error(`Style ${id} names a maker that is not listed: ${style.maker}.`);
    for (const from of style.made_from ?? []) if (!styles.has(from.style)) throw new Error(`Style ${id} is made from a style that is not listed: ${from.style}.`);
  }
  return { styles, makers };
}

// A value reference is { value: [path...] }; a path part is a key, an index, "*" (every element, first match wins),
// or { any_of: [keys] }. Anything else in a template is kept as it is.
export function lookup(root, pathParts) {
  let found = [root];
  for (const part of pathParts) {
    found = found.flatMap(node => {
      if (node == null) return [];
      if (part === '*') return Array.isArray(node) ? node : [];
      if (part && typeof part === 'object' && Array.isArray(part.any_of)) return part.any_of.map(key => node[key]).filter(value => value !== undefined);
      return node[part] === undefined ? [] : [node[part]];
    });
  }
  return found[0];
}
export function fill(template, values) {
  if (Array.isArray(template)) return template.flatMap(item => (item && typeof item === 'object' && Array.isArray(item.each)) ? (lookup(values, item.each) ?? []).map(each => fill(item.item, { ...values, item: each })) : [fill(item, values)]);
  if (template && typeof template === 'object') {
    if (Array.isArray(template.value)) return lookup(values, template.value);
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, values)]));
  }
  return template;
}
const joined = (parts, values) => (parts ?? []).map(part => (typeof part === 'string' ? part : String(fill(part, values) ?? ''))).join('');

/** The input field that names the recording (format namespace-file), the text fields, and the number and list fields, from the style's schema. */
function fieldsOf(style) {
  const properties = style.input_schema?.properties ?? {};
  const recording = Object.keys(properties).find(name => properties[name]?.format === 'namespace-file') ?? null;
  const texts = Object.keys(properties).filter(name => properties[name]?.type === 'string' && name !== recording);
  const numbers = Object.keys(properties).filter(name => ['number', 'integer'].includes(properties[name]?.type) && name !== 'count' && name !== 'at');
  const lists = Object.keys(properties).filter(name => properties[name]?.type === 'array');
  return { recording, texts, numbers, lists };
}

// A list field keeps its texts and numbers only, each text as plain words, at most MAX_LIST of them.
const MAX_LIST = 64;
const listOf = value => (Array.isArray(value) ? value : [])
  .filter(item => (typeof item === 'string' && item.trim()) || Number.isFinite(item))
  .slice(0, MAX_LIST)
  .map(item => (typeof item === 'string' ? plain(item, 2000) : item));

export function runProgram(program, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

export function grabFrame(video, seconds, output) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(seconds), '-i', video, '-frames:v', '1', '-q:v', '2', output]);
}

const defaults = {
  fetchImpl: (...args) => fetch(...args),
  readKey: path => (existsSync(path) ? readFileSync(path, 'utf8').trim() : ''),
  // The relay this run was given ({ url, person, key }), or null.
  readRelay: path => (path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null),
  relayPath: null,
  runProcess: runProgram,
  grabFrame,
  bestTime: video => bestPosterTime(video).t,
  cwd: dirname(here),
};

/**
 * Makes one style `count` times into `outDir`. `deps` may replace fetchImpl, readKey(path), readRelay(path) and
 * relayPath (the file the run's relay is placed at), runProcess(program, args,
 * { cwd, timeoutMs }) → { code, stderr }, grabFrame(video, seconds, output), bestTime(video) and cwd (where a
 * maker's program runs). `personSettings` are the person's settings for this computer, laid over the maker's and the
 * style's. Returns { made: [{ file, media_type, bytes }], failed: [{ error }] }.
 */
export async function makeStyle({ rows, styleId, input, outDir: out, workDir: work, count, seen = [], personSettings = {}, deps: given = {} }) {
  const deps = { ...defaults, ...given };
  // A maker's program runs in its own folder, so every path handed to it is absolute.
  const outDir = absolute(out);
  const workDir = absolute(work);
  const style = rows.styles.get(styleId);
  if (!style) throw new Error(`There is no style ${styleId}.`);
  if (seen.includes(styleId) || seen.length >= MAX_DEPTH) throw new Error(`Style ${styleId} depends on itself.`);
  const maker = rows.makers.get(style.maker);
  const wanted = Math.min(Math.max(Number.isInteger(count) ? count : Number.isInteger(input.count) ? input.count : style.count ?? 1, 1), MAX_COUNT);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const { recording, texts, numbers, lists } = fieldsOf(style);
  const named = {};
  const images = [];
  for (const field of texts) if (typeof input[field] === 'string' && input[field].trim()) named[field] = plain(input[field], 2000);
  for (const field of numbers) if (Number.isFinite(input[field])) named[field] = input[field];
  for (const field of lists) if (listOf(input[field]).length) named[field] = listOf(input[field]);
  for (const field of style.input_schema?.required ?? []) {
    if (field !== recording && named[field] === undefined) throw new Error(`Say what the ${field} is.`);
  }
  // A style that does not look at frames hands its maker the recording itself (a program that hears or watches all of it).
  if (recording && !style.frames && typeof input[recording] === 'string' && input[recording]) named[recording] = input[recording];
  if (recording && !style.frames && (style.input_schema?.required ?? []).includes(recording) && named[recording] === undefined) {
    throw new Error(`Choose the ${recording} to make it from.`);
  }
  // Only a style that looks at frames (frames) takes them; a style made from others hands them the recording.
  if (recording && style.frames) {
    const video = input[recording];
    if (typeof video !== 'string' || !video) throw new Error('Choose a recording to take the frame from.');
    const at = Number.isFinite(input.at) ? input.at : deps.bestTime(video);
    // Several frames (frames.count) spread frames.spread_seconds apart around the moment, so a model that must keep
    // a face sees it more than once.
    const frames = Math.max(1, Math.min(Number(style.frames.count) || 1, 6));
    const spread = Number(style.frames.spread_seconds) || 0;
    for (let index = 0; index < frames; index += 1) {
      const time = Math.max(0, at + (index - (frames - 1) / 2) * spread);
      const path = join(workDir, `${styleId}-frame-${index}.jpg`);
      deps.grabFrame(video, time, path);
      images.push({ path, media_type: 'image/jpeg' });
    }
    named[recording] = images[0].path;
  }
  for (const from of style.made_from ?? []) {
    const sub = await makeStyle({ rows, styleId: from.style, input, outDir: join(workDir, from.style), workDir: join(workDir, `${from.style}-work`), count: 1, seen: [...seen, styleId], personSettings, deps: given });
    if (!sub.made.length) throw new Error(`The ${rows.styles.get(from.style).label} step failed: ${sub.failed[0]?.error ?? 'it made nothing'}`);
    images.push({ path: sub.made[0].file, media_type: sub.made[0].media_type });
    named[from.name] = sub.made[0].file;
  }
  for (const image of images) image.base64 = readFileSync(image.path).toString('base64');
  // The person's settings may also come in the input (`settings`, the tool's settings record as one object), over a file's.
  const inInput = input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : {};
  const settings = { ...(maker.settings ?? {}), ...(style.settings ?? {}), ...personSettings, ...inInput };
  const prompt = style.prompt ? joined(style.prompt, { inputs: named, settings }) : '';

  // A maker that makes every result in one run (a local model loaded once, a search that keeps its best few) is given one
  // folder and the count; each file of the style's kind it leaves there, in name order, is one result.
  if (maker.makes_all) {
    const folder = join(workDir, `${styleId}-all.partial`);
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    try {
      const values = { prompt, settings, images, inputs: named, output: { folder, count: wanted } };
      await callProcess(maker, values, deps, { allInto: folder });
      const written = readdirSync(folder).filter(name => name.endsWith(style.extension) && statSync(join(folder, name)).size > 0).sort().slice(0, wanted);
      if (!written.length) throw new Error(`${maker.label} finished without writing a ${style.extension} file.`);
      // A result may come with `<its name>.json` beside it (the seed, the prompt, how long it took): it is kept as the
      // result's `about`, never as a result of its own.
      const made = written.map((name, index) => {
        const file = join(outDir, `${styleId}-${index + 1}${style.extension}`);
        renameSync(join(folder, name), file);
        const beside = join(folder, `${name}.json`);
        const about = existsSync(beside) ? JSON.parse(readFileSync(beside, 'utf8')) : undefined;
        return { file, media_type: style.media_type, bytes: statSync(file).size, ...(about ? { about } : {}) };
      });
      const failed = made.length < wanted ? [{ error: `${maker.label} made ${made.length} of the ${wanted} asked for.` }] : [];
      return { made, failed };
    } catch (error) {
      return { made: [], failed: [{ error: plain(error.message, 400) }] };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  const one = async index => {
    // Named with the kind it will be, so a program that picks its format from the name writes the right one.
    const partial = join(workDir, `${styleId}-${index}.partial${style.extension}`);
    try {
      const values = { prompt, settings, images, inputs: named, output: { path: partial } };
      const said = maker.runs_as === 'http' ? await callHttp(maker, values, deps) : await callProcess(maker, values, deps);
      if (!existsSync(partial) || statSync(partial).size === 0) throw new Error(`${maker.label} made an empty file.`);
      const file = join(outDir, `${styleId}-${index + 1}${style.extension}`);
      if (said && said !== style.media_type) {
        // Named for what it is: a service that answered in another format is converted to the one this style makes.
        const typed = `${partial}${EXTENSIONS[said] ?? ''}`;
        renameSync(partial, typed);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', typed, file]);
        rmSync(typed, { force: true });
      } else renameSync(partial, file);
      return { file, media_type: style.media_type, bytes: statSync(file).size };
    } catch (error) {
      rmSync(partial, { force: true });
      return { error: plain(error.message, 400) };
    }
  };
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(maker.concurrency ?? 1, wanted) }, async () => {
    while (next < wanted) { const index = next++; results[index] = await one(index); }
  }));
  return { made: results.filter(item => item.file), failed: results.filter(item => item.error) };
}

async function callHttp(maker, values, deps) {
  const { connection, placement } = maker.key;
  const key = deps.readKey(connection.mount_path);
  if (!key) {
    const relay = maker.through_trillion ? deps.readRelay(deps.relayPath) : null;
    if (!relay) throw new Error(`${maker.label} needs your connected account, and none was given to this run.`);
    return callRelay(maker, values, deps, relay);
  }
  const headers = {};
  let url = joined(maker.request.url, values);
  const placed = `${placement.prefix ?? ''}${key}`;
  if (placement.kind === 'query') url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(placement.name)}=${encodeURIComponent(placed)}`;
  else headers[placement.name] = placed;
  headers['content-type'] = 'application/json';
  const answer = await deps.fetchImpl(url, { method: maker.request.method ?? 'POST', headers, body: JSON.stringify(fill(maker.request.body, values)), signal: AbortSignal.timeout(maker.timeout_ms ?? 120000) });
  const text = await answer.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const data = json && lookup(json, maker.response.base64_path);
  if (!answer.ok || typeof data !== 'string') {
    const said = json && maker.response.error_path ? lookup(json, maker.response.error_path) : null;
    throw new Error(`${maker.label} answered ${answer.status}${said ? `: ${plain(String(said).replaceAll(key, '[key]'), 240)}` : answer.ok ? ' without a picture or sound' : ''}.`);
  }
  return keepAnswer(maker, json, values);
}

/** Writes the bytes an answer carries to the output file; returns the media type the answer names, or null. */
function keepAnswer(maker, json, values) {
  writeFileSync(values.output.path, Buffer.from(lookup(json, maker.response.base64_path), 'base64'));
  const said = maker.response.media_type_path ? lookup(json, maker.response.media_type_path) : null;
  return typeof said === 'string' ? said : null;
}

// The same request sent through the relay: the maker's through_trillion tool, its input, and the maker's body.
async function callRelay(maker, values, deps, relay) {
  const { tool, input } = maker.through_trillion;
  const answer = await deps.fetchImpl(relay.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${relay.key}`, 'x-trillion-person': relay.person },
    // One request key per call: the relay owner keeps the call's charge and answer under it.
    body: JSON.stringify({ tool_id: tool, request_key: crypto.randomUUID(), input: { ...fill(input ?? {}, values), body: fill(maker.request.body, values) } }),
    signal: AbortSignal.timeout(maker.timeout_ms ?? 120000),
  });
  const text = await answer.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!answer.ok || typeof lookup(json, maker.response.base64_path) !== 'string') {
    const said = typeof json?.error === 'string' ? json.error : json && maker.response.error_path ? lookup(json, maker.response.error_path) : null;
    throw new Error(`${maker.label} answered ${answer.status}${said ? `: ${plain(String(said).replaceAll(relay.key, '[key]'), 240)}` : answer.ok ? ' without a picture or sound' : ''}.`);
  }
  return keepAnswer(maker, json, values);
}

// The command is filled whole, so an { each, item } part becomes one argument per element of a list (a flag's values).
// A value that is absent stops the run by name: an empty argument would reach the program as a real one.
async function callProcess(maker, values, deps, { allInto } = {}) {
  const missing = maker.command.find(part => part && typeof part === 'object' && Array.isArray(part.value) && [undefined, null, ''].includes(lookup(values, part.value)));
  if (missing) throw new Error(`${maker.label} needs ${missing.value.join('.')}, and this run has none: give it in the input or in --settings.`);
  const [program, ...args] = fill(maker.command, values).map(part => String(part ?? ''));
  const done = await deps.runProcess(program, args, { cwd: deps.cwd, timeoutMs: maker.timeout_ms ?? 300000 });
  if (done.code !== 0) throw new Error(`${maker.label} stopped: ${tail(done.stderr || `exit ${done.code}`, 240)}`);
  if (allInto) return null;
  // Some programs append their own suffix; take the file they wrote when the exact name is absent.
  if (!existsSync(values.output.path)) {
    const folder = dirname(values.output.path);
    const written = readdirSync(folder).find(file => file.startsWith(basename(values.output.path)) && file !== basename(values.output.path));
    if (!written) throw new Error(`${maker.label} finished without writing a file.`);
    renameSync(join(folder, written), values.output.path);
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    const styleId = args.get('style');
    if (!styleId) throw new Error('usage: make-pictures-and-sounds.mjs --style <style id> [--out <folder>] [--work <folder>] [--settings <file>] < input.json');
    const raw = readFileSync(0, 'utf8').trim();
    const input = raw ? JSON.parse(raw) : {};
    const rows = readMakeRows();
    const outDir = args.get('out') ?? 'made';
    const personSettings = args.get('settings') ? JSON.parse(readFileSync(args.get('settings'), 'utf8')) : {};
    if (!personSettings || typeof personSettings !== 'object' || Array.isArray(personSettings)) throw new Error('--settings must name a file holding one JSON object.');
    const result = await makeStyle({ rows, styleId, input, outDir, workDir: args.get('work') ?? 'making', personSettings, deps: { relayPath: args.get('relay') ?? null } });
    if (!result.made.length) throw new Error(result.failed[0]?.error ?? 'Nothing was made.');
    const style = rows.styles.get(styleId);
    process.stdout.write(`${JSON.stringify({ style: styleId, makes: style.makes, count: result.made.length, made: result.made.map(item => ({ name: basename(item.file), media_type: item.media_type, bytes: item.bytes, ...(item.about ? { about: item.about } : {}) })), failed: result.failed })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
