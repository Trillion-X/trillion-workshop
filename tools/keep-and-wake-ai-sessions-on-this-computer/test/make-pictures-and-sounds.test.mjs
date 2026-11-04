// Making pictures and sounds: every style row becomes its own Workshop tool, each tool names only the connection its
// makers use, and the one runner turns a style into new files from a real clip (frames cut with ffmpeg, a service
// answered by a stand-in, a program run for real), never writing the recording and never leaking the key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payloadsIn, toolRowsFromSources } from '../parts/ai-tool-catalog/do-work/derive-tool-rows-from-sources.mjs';
import { makeStyle, readMakeRows, runProgram } from '../parts/media-composition/do-work/make-pictures-and-sounds.mjs';
import { buildInvocation, connectionFieldName, credentialMounts, schemaProblems } from '../src/workshop.mjs';

const root = new URL('..', import.meta.url).pathname;
const rows = readMakeRows();
const A = `1f:${'a'.repeat(64)}`;
const KEY = 'test-key-that-must-never-show';

async function derivedRows() {
  const derived = await toolRowsFromSources(payloadsIn(join(root, 'records/workshop-media-generation-tool-records.json')));
  assert.deepEqual(derived.unread, []);
  assert.deepEqual(derived.refused, []);
  return derived.rows;
}

/** The connections a style's makers read keys from, its own and those of the styles it is made from. */
function connectionsOf(styleId) {
  const style = rows.styles.get(styleId);
  const makers = [style.maker, ...(style.made_from ?? []).map(from => rows.styles.get(from.style).maker)].map(id => rows.makers.get(id));
  return [...new Map(makers.filter(maker => maker.key).map(maker => [maker.key.connection.mount_path, maker.key.connection])).values()];
}

test('every style is its own Workshop tool with a described screen, derived from the style row alone', async () => {
  const tools = await derivedRows();
  assert.deepEqual(tools.map(tool => tool.id), [...rows.styles.keys()].map(id => `tool:make-${id}`));
  for (const tool of tools) {
    const id = tool.id.slice('tool:make-'.length);
    const style = rows.styles.get(id);
    assert.equal(tool.label, style.label);
    const { inputs, shows, ...screen } = tool.screen;
    assert.deepEqual(shows, ['files'], 'what a style made shows as the files themselves');
    // The folder it sits in (screen.group) is the template's, the same for every style.
    assert.deepEqual(screen, { kind: 'described', group: 'make-pictures-and-sounds', icon: style.icon, label: style.short_label, about: style.about });
    // Every input the style takes is named for people by the one shared inputs row.
    for (const name of Object.keys(style.input_schema.properties)) assert.ok(inputs[name]?.label, `${id} ${name}`);
    assert.deepEqual(tool.invoke.argv.slice(0, 4), ['node', 'do-work/make-pictures-and-sounds.mjs', '--style', id]);
    assert.deepEqual(tool.invoke.stdin, { fill: { from: 'input' } }, 'the whole input is read on standard input at run time');
    assert.equal(tool.invoke.outputs[0].media_type, style.media_type);
    assert.equal(tool.invoke.outputs[0].keep_in, 'files', 'what is made is kept in the person\'s own files');
    assert.deepEqual(tool.placements, ['placement:deployed-container']);
  }
});

test('a style names exactly the connection its makers read, and the runner finds the key where the tool places it', async () => {
  for (const tool of await derivedRows()) {
    const id = tool.id.slice('tool:make-'.length);
    const wanted = connectionsOf(id);
    if (!wanted.length) {
      assert.equal(tool.invoke.connection_id, undefined, `${id} uses no connected account`);
      assert.equal(tool.invoke.credential_mounts, undefined);
      continue;
    }
    assert.equal(wanted.length, 1, `${id} reads one connection`);
    assert.equal(tool.invoke.connection_id, wanted[0].connection_id);
    assert.deepEqual(credentialMounts(tool.invoke), [{ secret_name: connectionFieldName(wanted[0].connection_id, wanted[0].field_id), mount_path: wanted[0].mount_path }]);
  }
});

test('each tool takes the input its schema describes and fills its command and standard input from it', async () => {
  const samples = { video: A, at: 3, topic: 'serve and volley', sound: 'a ball hit hard', mood: 'calm' };
  for (const tool of await derivedRows()) {
    const input = Object.fromEntries(Object.keys(tool.input_schema.properties).filter(name => name in samples).map(name => [name, samples[name]]));
    assert.deepEqual(schemaProblems(input, tool.input_schema), [], tool.id);
    const built = await buildInvocation(tool.invoke, { input, task: { task_id: 't' } });
    assert.deepEqual(built.stdin, input);
  }
});

// A stand-in for the image and sound service: answers the way Google AI does, with base64 bytes in the first part
// that carries them. It records what it was sent so the test can see the frames and the key's placement.
function standIn(bytes, mediaType, sent) {
  return async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: mediaType, data: bytes.toString('base64') } }] } }] }), { status: 200 });
  };
}

test('the runner makes new files from a real clip and never writes the recording', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'make-pictures-'));
  try {
    const clip = join(folder, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=8', '-shortest', clip]);
    const before = readFileSync(clip);
    const jpeg = join(folder, 'answer.jpg');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36', '-frames:v', '1', jpeg]);
    const deps = { readKey: path => (path === connectionsOf('striking-picture-of-you')[0].mount_path ? KEY : ''), bestTime: () => 4 };

    // A style that looks at three frames sends all three, with the key only in its header; a JPEG answer becomes the PNG the style makes.
    const sent = [];
    const striking = await makeStyle({ rows, styleId: 'striking-picture-of-you', input: { video: clip, at: 4, topic: 'serve and volley', count: 2 }, outDir: join(folder, 'made'), workDir: join(folder, 'work'), deps: { ...deps, fetchImpl: standIn(readFileSync(jpeg), 'image/jpeg', sent) } });
    assert.equal(striking.made.length, 2);
    assert.deepEqual(striking.failed, []);
    for (const item of striking.made) {
      assert.match(item.file, /striking-picture-of-you-\d\.png$/);
      assert.equal(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', item.file], { encoding: 'utf8' }).trim(), 'png');
    }
    assert.equal(sent[0].body.contents[0].parts.filter(part => part.inline_data).length, 3, 'three frames of the person');
    assert.match(sent[0].body.contents[0].parts[0].text, /serve and volley/);
    assert.equal(sent[0].headers['x-goog-api-key'], KEY);
    assert.equal(sent[0].url.includes(KEY), false);

    // A style made from others runs them first and keeps only its own result: a real ffmpeg placement over a made background.
    const png = join(folder, 'answer.png');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180', '-frames:v', '1', png]);
    const placed = await makeStyle({ rows, styleId: 'cut-out-on-a-new-background', input: { video: clip, topic: 'a grass court', count: 1 }, outDir: join(folder, 'placed'), workDir: join(folder, 'placing'), deps: {
      ...deps, fetchImpl: standIn(readFileSync(png), 'image/png', []),
      // The person-cutting model runs in the container; here its program is stood in for by one that writes a transparent picture.
      runProcess: (program, args, options) => (program === 'python3'
        ? runProgram('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white@0.5:s=160x120,format=rgba', '-frames:v', '1', args.at(-2)], options)
        : runProgram(program, args, options)),
    } });
    assert.deepEqual(placed.failed, []);
    assert.equal(placed.made.length, 1);
    assert.ok(statSync(placed.made[0].file).size > 0);
    assert.equal(existsSync(join(folder, 'placed', 'background-about-the-video-1.png')), false, 'the steps it was made from stay out of what is kept');
    assert.deepEqual(readFileSync(clip), before, 'the recording is unchanged');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a refusal is reported in the service\'s words without the key, and nothing half-made is kept', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'make-sounds-'));
  try {
    const refusing = async () => new Response(JSON.stringify({ error: { message: `API key ${KEY} is not valid` } }), { status: 400 });
    const result = await makeStyle({ rows, styleId: 'music', input: { mood: 'calm' }, outDir: join(folder, 'made'), workDir: join(folder, 'work'), deps: { readKey: () => KEY, fetchImpl: refusing } });
    assert.equal(result.made.length, 0);
    assert.equal(result.failed.length, rows.styles.get('music').count);
    assert.match(result.failed[0].error, /answered 400: API key \[key\] is not valid/);
    assert.equal(result.failed[0].error.includes(KEY), false);
    assert.deepEqual(readdirSync(join(folder, 'work')).filter(name => name.includes('.partial')), [], 'no half-made file is left');
    assert.deepEqual(readdirSync(join(folder, 'made')), []);
    const unconnected = await makeStyle({ rows, styleId: 'sound-effect', input: { sound: 'a door' }, outDir: join(folder, 'made'), workDir: join(folder, 'work'), deps: { readKey: () => '' } });
    assert.match(unconnected.failed[0].error, /needs your connected account/);
    await assert.rejects(makeStyle({ rows, styleId: 'music', input: {}, outDir: join(folder, 'made'), workDir: join(folder, 'work') }), /Say what the mood is/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('with no connected account, a maker Trillion can pay for sends the same request through the run\'s relay', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'make-relayed-'));
  try {
    const relayFile = join(folder, 'relay.json');
    const RELAY_KEY = 'relay-key-that-must-never-show';
    writeFileSync(relayFile, JSON.stringify({ url: 'https://trillion.test/workshop/relay', person: 'f'.repeat(64), key: RELAY_KEY }));
    const sent = [];
    const mp3 = Buffer.from('ID3 stand-in sound');
    const music = await makeStyle({ rows, styleId: 'music', input: { mood: 'calm piano' }, outDir: join(folder, 'made'), workDir: join(folder, 'work'), deps: { readKey: () => '', relayPath: relayFile, fetchImpl: standIn(mp3, 'audio/mpeg', sent) } });
    assert.deepEqual(music.failed, []);
    assert.equal(music.made.length, rows.styles.get('music').count);
    assert.deepEqual(readFileSync(music.made[0].file), mp3);
    const maker = rows.makers.get(rows.styles.get('music').maker);
    assert.equal(sent[0].url, 'https://trillion.test/workshop/relay');
    assert.equal(sent[0].headers.authorization, `Bearer ${RELAY_KEY}`);
    assert.equal(sent[0].headers['x-trillion-person'], 'f'.repeat(64));
    assert.equal(sent[0].body.tool_id, maker.through_trillion.tool);
    assert.deepEqual(sent[0].body.input.path, { model: maker.settings.model }, 'the model rides as the gateway tool\'s own field');
    assert.match(sent[0].body.input.body.contents[0].parts[0].text, /calm piano/, 'the body is the maker\'s own request body');

    // The relay's refusal (no credit left, a gateway error) is said in its words, without the key.
    const refusing = async () => new Response(JSON.stringify({ error: `A sound costs $0.04 a call; key ${RELAY_KEY} has no credit left.` }), { status: 400 });
    const refused = await makeStyle({ rows, styleId: 'sound-effect', input: { sound: 'a door' }, outDir: join(folder, 'made2'), workDir: join(folder, 'work2'), deps: { readKey: () => '', relayPath: relayFile, fetchImpl: refusing } });
    assert.equal(refused.made.length, 0);
    assert.match(refused.failed[0].error, /answered 400: A sound costs \$0\.04 a call; key \[key\] has no credit left/);

    // A connected account is still used first, and the relay is not asked.
    const own = [];
    await makeStyle({ rows, styleId: 'sound-effect', input: { sound: 'a door' }, outDir: join(folder, 'made3'), workDir: join(folder, 'work3'), deps: { readKey: () => KEY, relayPath: relayFile, fetchImpl: standIn(mp3, 'audio/mpeg', own) } });
    assert.ok(own.every(call => !call.url.includes('/workshop/relay') && call.headers['x-goog-api-key'] === KEY));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a style may not be made from itself', async () => {
  const looped = { styles: new Map(rows.styles), makers: rows.makers };
  looped.styles.set('loop', { ...rows.styles.get('cut-out-on-a-new-background'), made_from: [{ name: 'again', style: 'loop' }] });
  const folder = mkdtempSync(join(tmpdir(), 'make-loop-'));
  try {
    writeFileSync(join(folder, 'clip.mp4'), '');
    await assert.rejects(makeStyle({ rows: looped, styleId: 'loop', input: { video: join(folder, 'clip.mp4'), topic: 'x' }, outDir: join(folder, 'made'), workDir: join(folder, 'work') }), /depends on itself/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
