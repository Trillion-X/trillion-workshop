import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { selectPublishedIcon, writeNativeAppIcons } from '../src/native-app-icon.mjs';

const home = 'https://example.sites.example.test/';
const installation = files => ({ public_url: home, files });
const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#E36F25' } }).png().toBuffer();
const published = `data:image/png;base64,${png.toString('base64')}`;

test('native icon uses only an icon declared by the current installed app', async () => {
  const current = installation({
    'index.html': '<title>Example</title><link rel="apple-touch-icon" href="/brand/touch.png"><link rel="icon" href="https://foreign.example/icon.png">',
    'brand/touch.png': published,
  });
  const icon = await selectPublishedIcon(current);
  assert.equal(icon.path, 'brand/touch.png');
  assert.deepEqual(icon.bytes, png);
  assert.equal(await selectPublishedIcon(installation({
    'index.html': '<link rel="icon" href="https://foreign.example/icon.png"><link rel="icon" href="/unpublished.png">',
    'brand/touch.png': published,
  })), null);
});

test('manifest icon must also belong to the installed app', async () => {
  const icon = await selectPublishedIcon(installation({
    'index.html': '<link rel="manifest" href="/site.webmanifest">',
    'site.webmanifest': JSON.stringify({ icons: [{ src: '/brand/touch.png' }] }),
    'brand/touch.png': published,
  }));
  assert.equal(icon?.path, 'brand/touch.png');
});

test('a referenced icon uses only the bytes in the current publication', async () => {
  const file = { blob_ref: `maker:${'a'.repeat(64)}:1f:${bytesToHex(blake3(png))}`, media_type: 'image/png', size: png.length };
  const current = installation({ 'index.html': '<link rel="icon" href="/icon.png">', 'icon.png': file });
  const fetchIcon = async url => {
    assert.equal(url.href, `${home}icon.png`);
    return new Response(png, { status: 200 });
  };
  assert.equal((await selectPublishedIcon(current, fetchIcon))?.path, 'icon.png');
  assert.equal(await selectPublishedIcon(current, async () => new Response(Buffer.from('wrong'), { status: 200 })), null);
});

test('generated iPhone and Mac catalogs use the published art or a Studioform name mark', async () => {
  const builds = join(homedir(), 'Library', 'Developer', 'Fixture', 'AppProjectBuilds');
  await mkdir(builds, { recursive: true });
  const root = await mkdtemp(join(builds, 'icon-test-'));
  const fallback = await writeNativeAppIcons(root, 'Studioform');
  assert.deepEqual(fallback, { source: 'name', initial: 'S' });
  const phone = join(root, 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon.png');
  const mac = join(root, 'App', 'Assets.xcassets', 'MacAppIcon.appiconset', 'icon_512x512@2x.png');
  assert.deepEqual((({ width, height, hasAlpha }) => ({ width, height, hasAlpha }))(await sharp(await readFile(phone)).metadata()),
    { width: 1024, height: 1024, hasAlpha: false });
  assert.deepEqual((({ width, height, hasAlpha }) => ({ width, height, hasAlpha }))(await sharp(await readFile(mac)).metadata()),
    { width: 1024, height: 1024, hasAlpha: true });
  assert.equal(JSON.parse(await readFile(join(root, 'App', 'Assets.xcassets', 'MacAppIcon.appiconset', 'Contents.json'))).images.length, 10);
  const used = await writeNativeAppIcons(root, 'Studioform', { path: 'brand/touch.png', bytes: png });
  assert.equal(used.source, 'published:brand/touch.png');
  const pixel = await sharp(await readFile(phone)).extract({ left: 512, top: 512, width: 1, height: 1 }).raw().toBuffer();
  assert.deepEqual([...pixel], [227, 111, 37]);
});
