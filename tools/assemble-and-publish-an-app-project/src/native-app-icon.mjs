// Native app icons come only from files in the current published installation.
// The name mark is used when that installation does not declare a usable icon.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedPublicAppFile, publicAppFilePath } from 'trillion-workshop/tools/shared-code/src/public-app-files.mjs';

const MAX_ICON_BYTES = 5_000_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/svg+xml']);
const MAC_SIZES = [16, 32, 128, 256, 512];

function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    values[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  }
  return values;
}

function ownFile(href, base, origin, files) {
  if (typeof href !== 'string' || !href || href.length > 500) return null;
  let url, path;
  try {
    url = new URL(href, base);
    path = decodeURIComponent(url.pathname.slice(1));
    if (url.origin !== origin || url.search || url.hash || !Object.hasOwn(files, path) ||
        publicAppFilePath(path) !== path) return null;
  } catch { return null; }
  return path;
}

async function installedBytes(installation, path, fetchImpl) {
  const file = checkedPublicAppFile(path, installation.files[path]);
  if (file.bytes) return Buffer.from(file.bytes);
  const url = new URL(path, installation.public_url);
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_ICON_BYTES) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ICON_BYTES) return null;
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length > MAX_ICON_BYTES || `1f:${bytesToHex(blake3(bytes))}` !== file.blob_ref.split(':').slice(-2).join(':')) return null;
  return bytes;
}

export async function selectPublishedIcon(installation, fetchImpl = fetch) {
  const files = installation?.files;
  if (!files || !Object.hasOwn(files, 'index.html')) return null;
  const home = new URL(installation.public_url);
  if (home.protocol !== 'https:' || home.pathname !== '/') return null;
  let html;
  try { html = (await installedBytes(installation, 'index.html', fetchImpl))?.toString('utf8'); } catch { return null; }
  if (!html) return null;
  const icons = [], manifests = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = attributes(tag);
    const rel = (attr.rel ?? '').toLowerCase().split(/\s+/);
    const path = ownFile(attr.href, home, home.origin, files);
    if (!path) continue;
    if (rel.includes('apple-touch-icon') || rel.includes('icon')) {
      icons.push({ path, priority: rel.includes('apple-touch-icon') ? 0 : 1 });
    } else if (rel.includes('manifest')) manifests.push(path);
  }
  for (const manifest of manifests) {
    try {
      const data = JSON.parse((await installedBytes(installation, manifest, fetchImpl)).toString('utf8'));
      for (const icon of data.icons ?? []) {
        const path = ownFile(icon.src, new URL(manifest, home), home.origin, files);
        if (path) icons.push({ path, priority: 2 });
      }
    } catch { /* An unusable manifest does not prevent the app-name fallback. */ }
  }
  for (const { path } of icons.sort((a, b) => a.priority - b.priority)) {
    try {
      const media = checkedPublicAppFile(path, files[path]).media_type.split(';')[0];
      if (!IMAGE_TYPES.has(media)) continue;
      const bytes = await installedBytes(installation, path, fetchImpl);
      if (!bytes || bytes.length > MAX_ICON_BYTES) continue;
      const image = sharp(bytes, { limitInputPixels: 32_000_000 });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192) continue;
      await image.resize(1024, 1024, { fit: 'contain' }).png().toBuffer();
      return { path, bytes };
    } catch { /* Try the next icon explicitly published by this installation. */ }
  }
  return null;
}

function nameMark(name) {
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase('en-US') ?? '?';
  const safe = initial.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
  const digest = blake3(new TextEncoder().encode(name.normalize('NFC')));
  const palettes = [
    ['#142B35', '#EAF5EF'], ['#24355D', '#F1F2FF'], ['#47304F', '#FFF0F7'],
    ['#284A3C', '#F1F7DF'], ['#553A2B', '#FFF3E6'], ['#24495A', '#E9F7FA'],
  ];
  const [background, foreground] = palettes[digest[0] % palettes.length];
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${background}"/><text x="512" y="545" dominant-baseline="middle" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="570" fill="${foreground}">${safe}</text></svg>`);
}

export async function writeNativeAppIcons(output, name, publishedIcon = null) {
  const input = publishedIcon?.bytes ?? nameMark(name);
  const image = sharp(input, { limitInputPixels: 32_000_000 });
  const square = await image.resize(1024, 1024, { fit: 'contain', background: '#FFFFFF' })
    .flatten({ background: '#FFFFFF' }).png().toBuffer();
  const assets = join(output, 'App', 'Assets.xcassets');
  const phone = join(assets, 'AppIcon.appiconset');
  const mac = join(assets, 'MacAppIcon.appiconset');
  await mkdir(phone, { recursive: true });
  await mkdir(mac, { recursive: true });
  await writeFile(join(phone, 'AppIcon.png'), square);
  await writeFile(join(phone, 'Contents.json'), `${JSON.stringify({ images: [{ filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }], info: { author: 'xcode', version: 1 } }, null, 2)}\n`);
  const macImages = [];
  for (const points of MAC_SIZES) for (const scale of [1, 2]) {
    const size = points * scale;
    const inner = Math.round(size * 824 / 1024);
    const margin = Math.floor((size - inner) / 2);
    const rendered = await sharp(square).resize(inner, inner).png().toBuffer();
    const mask = Buffer.from(`<svg width="${inner}" height="${inner}"><rect width="${inner}" height="${inner}" rx="${Math.round(inner * .225)}" fill="white"/></svg>`);
    const rounded = await sharp(rendered).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    const filename = `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`;
    const canvas = await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
      .composite([{ input: rounded, left: margin, top: margin }]).png().toBuffer();
    await writeFile(join(mac, filename), canvas);
    macImages.push({ filename, idiom: 'mac', scale: `${scale}x`, size: `${points}x${points}` });
  }
  await writeFile(join(mac, 'Contents.json'), `${JSON.stringify({ images: macImages, info: { author: 'xcode', version: 1 } }, null, 2)}\n`);
  return { source: publishedIcon ? `published:${publishedIcon.path}` : 'name', initial: publishedIcon ? null : Array.from(name.trim())[0]?.toLocaleUpperCase('en-US') };
}
