import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../../headless-browser/launch.mjs';
import surfaces from '../../shared-code/src/workspace/screens.mjs';

const root = new URL('..', import.meta.url).pathname;
const clips = [
  { identity: '1f:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', file: '1f:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'First.mp4', title: 'First clip', in: 3, out: 13, duration: 20, bytes: '/media/first.mp4', media_type: 'video/mp4', media_kind: 'video' },
  { identity: '1f:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', file: '1f:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Second.mp4', title: 'Second clip', in: 0, out: 8, duration: 8, bytes: '/media/second.mp4', media_type: 'video/mp4', media_kind: 'video' },
];
const MUSIC = '1f:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const LOGO = '1f:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
// The person's files as Media lists them: an uploaded song and a picture a tool made.
const library = { revision: 'r1', rows: [
  { identity: MUSIC, origin: 'file', name: 'Music.mp3', media_kind: 'audio', media_type: 'audio/mpeg', file: MUSIC, stored: true, bytes: '/media/music.mp3', duration: 12 },
  { identity: LOGO, origin: 'made', name: 'logo.png', media_kind: 'image', media_type: 'image/png', file: LOGO, stored: true, bytes: '/media/logo.png', duration: null },
] };

test('media-edit is registered and paints the supplied playable clips and timeline without an API read', { timeout: 120000 }, async () => {
  const row = surfaces.surfaces.find(surface => surface.id === 'trillion.media-edit');
  assert.equal(row?.package_entry.entry_name, 'media-edit');

  const { outputFiles } = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      loader: 'ts',
      contents: `
        import { mountMediaEditScreen } from './src/workspace/media-edit-screen';
        window.fetches = [];
        window.fetch = async (url, init = {}) => {
          const path = String(url);
          const body = init.body ? JSON.parse(String(init.body)) : null;
          window.fetches.push({ path, body });
          if (path === '/work/api/namespace/write') {
            window.savedEdl = JSON.parse(body.text);
            return Response.json({ identity: '1f:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' });
          }
          if (path.startsWith('/work/api/namespace/bytes/')) return Response.json(window.savedEdl);
          if (path.startsWith('/work/api/media/edit?')) return Response.json({ edit: window.savedEdit });
          if (path === '/work/api/media/edit') {
            window.savedEdit = { id: body.id, title: body.title, ratio: body.ratio, clips: body.clips, file: body.file, panels: body.panels };
            return Response.json({ saved: true });
          }
          if (path === '/work/api/media/render') return Response.json({ task_id: 'render-1', state: 'queued' });
          if (path.startsWith('/work/api/media/library?')) {
            const query = new URL(path, 'https://app.gettrillion.ai/').searchParams;
            const rows = query.get('origin') === 'made' ? ${JSON.stringify(library.rows.filter(row => row.origin === 'made'))} : ${JSON.stringify(library.rows)};
            return Response.json({ revision: 'r1', rows, next_after: null });
          }
          return new Response('{}', { headers: { 'content-type': 'application/json' } });
        };
        const host = document.createElement('section');
        host.id = 'screen';
        document.body.append(host);
        window.mountEditor = (target, surfaceInput) => mountMediaEditScreen(target, { surfaceInput });
        mountMediaEditScreen(host, { surfaceInput: ${JSON.stringify({ title: 'Two clips', clips })} });
      `,
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': 'document.baseURI' },
    loader: { '.css': 'empty', '.wasm': 'empty' }, external: ['node:*'], logLevel: 'error',
  });
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.locator('[data-trillion-media-edit]').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Two clips' }).count(), 1);
    const timeline = page.getByRole('region', { name: 'Timeline' });
    const pictureClips = timeline.getByRole('button', { name: /^(First|Second) clip$/ });
    assert.equal(await timeline.getByRole('button', { name: 'First clip' }).count(), 1);
    assert.equal(await timeline.getByRole('button', { name: 'Second clip' }).count(), 1);
    assert.equal(await page.locator('[data-media-edit-panel="preview"] [data-live-composition]').count(), 1, 'the shared cut player paints immediately');
    for (const name of ['sources', 'preview', 'tools', 'timeline']) assert.equal(await page.locator(`[data-media-edit-panel="${name}"]`).count(), 1, `the ${name} panel is marked for the proof`);
    assert.equal(await page.evaluate(() => window.fetches.length), 0, 'the editor makes no API read before its first paint');

    await page.setViewportSize({ width: 390, height: 844 });
    const firstSource = page.getByRole('button', { name: /^Select clip 1,/ });
    const secondSource = page.getByRole('button', { name: /^Select clip 2,/ });
    assert.equal(await firstSource.isVisible(), true, 'mobile shows the source clip cards');
    assert.equal(await secondSource.isVisible(), true, 'the second source clip remains reachable in the horizontal strip');
    assert.ok(await firstSource.evaluate(element => element.classList.contains('h-auto') && Boolean(element.querySelector('.aspect-video'))), 'source cards grow to fit a picture kept at the video shape');
    assert.ok(await firstSource.evaluate(element => element.classList.contains('shrink-0')), 'source cards keep their width inside the horizontal strip');

    await page.setViewportSize({ width: 1280, height: 900 });

    const media = page.locator('[data-live-composition] video.live-composition-source');
    await media.waitFor();
    assert.match(await media.getAttribute('src'), /\/media\/first\.mp4$/, 'the whole cut plays from its first clip');
    await page.getByRole('button', { name: /Second clip/ }).first().click();
    assert.match(await media.getAttribute('src'), /\/media\/second\.mp4$/, 'choosing a clip moves the playhead to it');
    await page.getByRole('radio', { name: 'Selected clip' }).click();
    assert.match(await media.getAttribute('src'), /\/media\/second\.mp4$/, 'the player can play only the selected clip');
    await page.getByRole('radio', { name: 'Whole cut' }).click();
    await page.getByLabel('Start (seconds)').fill('2');
    await page.getByRole('button', { name: 'Trim selected clip' }).click();
    assert.equal(await pictureClips.count(), 2);
    // Put the playhead inside the second clip (cut time 10..16) by clicking the ruler at 80% (12.8 s), then split.
    const ruler = page.locator('[data-media-edit-panel="timeline"] [style*="ew-resize"]').first();
    const box = await ruler.boundingBox();
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.getByRole('button', { name: 'Split at playhead' }).click();
    assert.equal(await pictureClips.count(), 3, 'split at the playhead makes two clips of the one under it');
    await page.getByRole('button', { name: 'Undo' }).click();
    assert.equal(await pictureClips.count(), 2);
    await page.getByRole('button', { name: 'Redo' }).click();
    assert.equal(await pictureClips.count(), 3);
    await page.getByRole('button', { name: 'Undo' }).click();
    // Take out a marked stretch: 12.8 s back to the start of the second clip leaves what is either side of it.
    await page.getByRole('button', { name: 'Mark end' }).click();
    await page.mouse.click(box.x + box.width * (11 / 16), box.y + box.height / 2);
    await page.getByRole('button', { name: 'Mark start' }).click();
    await page.getByRole('button', { name: 'Take out marked' }).click();
    assert.equal(await pictureClips.count(), 3, 'taking out the middle of a clip keeps both sides');
    assert.match(await page.getByRole('heading', { name: 'Two clips' }).locator('..').textContent(), /3 clips · 0:14/);
    await page.getByRole('button', { name: 'Undo' }).click();
    assert.equal(await pictureClips.count(), 2);

    await page.getByRole('radio', { name: 'Text' }).click();
    await page.getByLabel('Caption for selected clip').fill('A {caption}');
    await page.getByRole('button', { name: /Add caption/ }).click();
    await page.getByLabel('Text for selected clip').fill('Opening title');
    await page.getByRole('button', { name: /Add text/ }).click();
    await page.getByRole('radio', { name: 'Colour' }).click();
    await page.locator('[data-media-edit-panel="look"]').waitFor();
    await page.getByRole('button', { name: 'VHS tape' }).click();
    assert.equal(await page.evaluate(() => window.fetches.some(item => item.path.startsWith('/work/api/media/library'))), false, 'files are read only when Layers opens');
    await page.getByRole('radio', { name: 'Layers' }).click();
    const layers = page.locator('[data-media-edit-panel="layers"]');
    await layers.getByRole('region', { name: 'Made with tools' }).getByRole('button', { name: 'Add logo.png' }).waitFor();
    assert.equal(await page.evaluate(() => window.fetches.some(item => item.path === '/work/api/media/library')), false, 'Layers reads bounded pages only');
    await layers.getByRole('button', { name: 'Music', exact: true }).click();
    await layers.getByRole('button', { name: 'Add Music.mp3 as Music' }).click();
    await layers.getByLabel('Volume').fill('0.4');
    await layers.getByRole('button', { name: 'Logo', exact: true }).click();
    await layers.getByRole('button', { name: 'Add logo.png as Logo' }).click();
    assert.equal(await page.getByRole('region', { name: 'Timeline' }).getByRole('button', { name: 'Music · Music.mp3' }).count(), 1, 'the music shows on the sounds track');
    assert.equal(await page.getByRole('region', { name: 'Timeline' }).getByRole('button', { name: 'Logo · logo.png' }).count(), 1, 'the logo shows on the pictures track');
    await page.getByRole('button', { name: 'Save edit' }).click();
    await page.getByText('Edit saved in Files.').waitFor();
    const saved = await page.evaluate(() => window.fetches.find(item => item.path === '/work/api/namespace/write')?.body);
    const savedEdl = JSON.parse(saved.text);
    assert.equal(savedEdl.spine.segments[1].look_stack, 'vhs');
    assert.match(savedEdl.subtitles.ass, /Dialogue: .*A  caption/);
    assert.equal(savedEdl.text_overlays[0].text, 'Opening title');
    assert.deepEqual(savedEdl.audio_graph.narration, [{ artifact: MUSIC, start: 10, in: 0, out: 12, volume: 0.4, fade_in: 2, fade_out: 3, duck: true }], 'added where the selected second clip starts in the cut');
    assert.deepEqual(savedEdl.image_overlays.map(row => [row.image_path, row.x, row.y, row.opacity]), [[LOGO, 'W*0.9-w/2', 'H*0.1-h/2', 0.85]]);

    await page.getByRole('button', { name: 'Render video' }).click();
    await page.getByText('Rendering started. Open the run to follow it.').waitFor();
    const render = await page.evaluate(() => window.fetches.find(item => item.path === '/work/api/media/render')?.body);
    assert.equal(render.edl.spine.segments[1].look_stack, 'vhs');
    assert.match(render.edl.subtitles.ass, /Dialogue: .*A  caption/);
    assert.equal(render.edl.text_overlays[0].text, 'Opening title');
    assert.equal(render.edl.audio_graph.narration[0].artifact, MUSIC);
    assert.equal(render.edl.image_overlays[0].image_path, LOGO);

    const reopened = page.locator('#reopened-editor');
    await page.evaluate(({ title, clips }) => {
      const host = document.createElement('section');
      host.id = 'reopened-editor';
      document.body.append(host);
      window.mountEditor(host, { title, clips, editId: 'saved-edit' });
    }, { title: 'Two clips', clips });
    await reopened.getByText('Saved edit restored.').waitFor();
    await reopened.getByRole('radio', { name: 'Text' }).click();
    await reopened.getByRole('region', { name: 'Text and captions' }).getByText('A  caption').waitFor();
    await reopened.getByRole('region', { name: 'Text and captions' }).getByText('Opening title').waitFor();
    assert.equal(await reopened.getByRole('region', { name: 'Timeline' }).getByRole('button', { name: 'Opening title' }).count(), 1, 'text on screen shows on the captions and text track');
    assert.equal(await reopened.getByRole('region', { name: 'Timeline' }).getByRole('button', { name: 'Music · Music.mp3' }).count(), 1, 'the music shows on the sounds track');
    await reopened.getByRole('button', { name: /^Select clip 2,/ }).click();
    await reopened.getByRole('radio', { name: 'Colour' }).click();
    assert.equal(await reopened.getByRole('button', { name: 'VHS tape' }).getAttribute('aria-pressed'), 'true');
    await reopened.getByRole('radio', { name: 'Layers' }).click();
    await reopened.getByRole('group', { name: 'Music: Music.mp3' }).or(reopened.getByLabel('Music: Music.mp3')).first().waitFor();
    assert.equal(await reopened.getByLabel('Logo: logo.png').count(), 1);

    // An edit saved before layers existed: its single music bed opens as the first sound and renders the same way.
    await page.evaluate(({ title, clips, music }) => {
      window.savedEdit = { id: 'older-edit', title, clips: clips.map(clip => ({ ...clip, start: clip.in, end: clip.out })), edl: { spine: { segments: [] }, audio_graph: { music_bed: { artifact: music, trim: [2, 10], volume: 0.5, fade_in: { st: 0, d: 1 }, fade_out: { st: 5, d: 3 }, duck: true } } } };
      const host = document.createElement('section');
      host.id = 'older-editor';
      document.body.append(host);
      window.mountEditor(host, { title, clips, editId: 'older-edit' });
    }, { title: 'Two clips', clips, music: MUSIC });
    const older = page.locator('#older-editor');
    await older.getByText('Saved edit restored.').waitFor();
    await older.getByRole('radio', { name: 'Layers' }).click();
    await older.getByLabel('Music: Saved music').waitFor();
    await older.getByRole('button', { name: 'Save edit' }).click();
    await older.getByText('Edit saved in Files.').waitFor();
    const resaved = await page.evaluate(() => window.savedEdl);
    assert.deepEqual(resaved.audio_graph.narration, [{ artifact: MUSIC, start: 0, in: 2, out: 10, volume: 0.5, fade_in: 1, fade_out: 3, duck: true }]);
    assert.equal(resaved.audio_graph.music_bed, undefined, 'the music is kept once, as a sound layer');
  } finally {
    await browser.close();
  }
});
