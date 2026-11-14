// parts/ui/show/share-card/share-card.ts
//
// PURPOSE
//   A card of someone's numbers to share, drawn as one SVG picture from DATA: a small line saying whose numbers these
//   are, one big headline, up to three numbers with a line under each, the line of every point over time, and a footer.
//   The same picture is shown in the page, saved as an image and used as a shared link's preview: cardPng turns it into
//   a PNG in the browser, so no server draws pictures. Modelled on Strava's share cards (big measured numbers, a
//   "was" beside the number that improved, one line of the whole history).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No product words: every word and number is the caller's DATA; this file only lays them out.
//   2. Every caller word is escaped before it enters the picture, so a card cannot carry markup.
//   3. The picture uses only system fonts, so the SVG and the PNG made from it look the same in every browser.

export type ShareCardStat = { label: string; value: string; detail?: string; tone?: string };
export type ShareCardLine = { label?: string; points: number[]; better?: 'lower' | 'higher' };
export type ShareCard = { headline: string; stats: ShareCardStat[]; line?: ShareCardLine; footer?: string };

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif';
const INK = '#f5f5f4';
const SOFT = '#a8a29e';
const GOOD = '#4ade80';
const QUIET = '#78716c';
const LINE_BAD = '#fbbf24';

const escape = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (x: number, y: number, size: number, fill: string, weight: number, content: string, extra = '') =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}"${extra}>${escape(content)}</text>`;

// A headline wider than the card is set smaller rather than cut; about 0.55em per character at this weight.
const fitSize = (words: string, width: number, largest: number) => Math.max(40, Math.min(largest, Math.floor(width / (Math.max(words.length, 1) * 0.55))));

/** Whether the line moved the way that counts as better, from its first point to its last. */
export function improved(line: ShareCardLine): boolean {
  const first = line.points[0], last = line.points[line.points.length - 1];
  return line.better === 'higher' ? last > first : last < first;
}

// The line of every point, fitted into a box, with a soft area under it.
function linePicture(line: ShareCardLine, box: { x: number; y: number; w: number; h: number }) {
  const points = line.points.filter(value => Number.isFinite(value));
  if (points.length < 2) return '';
  const low = Math.min(...points), high = Math.max(...points), span = high - low || 1;
  const at = points.map((value, index) => [box.x + (index / (points.length - 1)) * box.w, box.y + box.h - ((value - low) / span) * box.h]);
  const path = at.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const colour = improved({ ...line, points }) ? GOOD : LINE_BAD;
  const [endX, endY] = at[at.length - 1];
  return `<defs><linearGradient id="share-card-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colour}" stop-opacity="0.28"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></linearGradient></defs>`
    + `<path d="${path} L${(box.x + box.w).toFixed(1)} ${box.y + box.h} L${box.x} ${box.y + box.h} Z" fill="url(#share-card-area)"/>`
    + `<path d="${path}" fill="none" stroke="${colour}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="8" fill="${colour}"/>`
    + (line.label ? text(box.x, box.y + box.h + 34, 22, QUIET, 500, line.label) : '');
}

/** The card as one SVG picture, CARD_WIDTH by CARD_HEIGHT. */
export function shareCardSvg(card: ShareCard): string {
  const pad = 72;
  const stats = card.stats.slice(0, 3);
  const statWidth = 250;
  const headlineSize = fitSize(card.headline, card.line ? 640 : CARD_WIDTH - pad * 2, 76);
  const statY = 400;
  const parts = [
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="0" fill="#0c0a09"/>`,
    `<rect x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#share-card-glow)"/>`,
    `<defs><radialGradient id="share-card-glow" cx="0.85" cy="0.1" r="0.9"><stop offset="0" stop-color="#1c1917"/><stop offset="1" stop-color="#0c0a09"/></radialGradient></defs>`,
    text(pad, pad + 40 + headlineSize, headlineSize, INK, 700, card.headline, ' letter-spacing="-0.5"'),
    ...stats.map((stat, index) => {
      const x = pad + index * statWidth;
      return text(x, statY, 22, SOFT, 500, stat.label.toUpperCase(), ' letter-spacing="1.5"')
        + text(x, statY + 58, 52, INK, 700, stat.value)
        + (stat.detail ? text(x, statY + 96, 24, stat.tone === 'good' ? GOOD : QUIET, 500, stat.detail) : '');
    }),
    card.line ? linePicture(card.line, { x: 800, y: 150, w: 320, h: 170 }) : '',
    card.footer ? text(pad, CARD_HEIGHT - 48, 24, QUIET, 600, card.footer) : '',
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">${parts.join('')}</svg>`;
}

/** The card's picture as an address an image element can show. */
export const shareCardSrc = (card: ShareCard) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(shareCardSvg(card))}`;

/** The card as a PNG, drawn by this browser (the picture a shared link previews). */
export async function cardPng(card: ShareCard): Promise<Blob> {
  const image = new Image(CARD_WIDTH, CARD_HEIGHT);
  image.src = shareCardSrc(card);
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot draw pictures.');
  context.drawImage(image, 0, 0, CARD_WIDTH, CARD_HEIGHT);
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('This browser could not make the picture.'))), 'image/png'));
}
