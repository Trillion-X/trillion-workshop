/**
 * #230 Karaoke caption authorer (the word-by-word highlight that drives social-video retention). Turns a DATA
 * `lines` array (each {start, end, words:[{text,start,end}]}, exactly what caption-lines.ts emits) into an ASS
 * subtitle STRING where each word lights up in the highlight color AS IT IS SPOKEN (libass `\k` karaoke). The
 * render burns the string with ONE generic `ass=` filter over the whole program (video-compose `edl.subtitles.ass`),
 * so authoring lives here ONCE (SSOT) and the compositor stays blind to what the words mean (Physics vs Society).
 * ZERO new render code (L069): a karaoke reveal is just an authored ASS string the existing libass burn consumes;
 * a plain-subtitle or a two-line-block producer emits the same kind of string (L090). All DATA is sanitized into
 * the ASS grammar (BGR color ints, clamped+rounded centisecond \k, brace/newline-escaped text) so no field can
 * inject filter syntax.
 *
 * The shadow is decomposed DATA: { x, y, blur, spread, colour, opacity } in frame pixels. An offset with no blur
 * or spread is the classic drop shadow (libass Shadow). Any blur or spread is a soft halo: the same words drawn once
 * more on the layer beneath, invisible fill, an edge reaching `spread` past the letters and their outline, in the shadow colour blurred by `blur` (libass
 * draws no shadow at a zero offset, so a centred halo is that edge itself; an offset halo is the edge's shadow).
 */

// #rrggbb (or rrggbb) to ASS &HAABBGGRR& (ASS color is BGR with a leading alpha; 00 = opaque). Injection-safe:
// only hex digits survive; anything malformed falls back to white/black.
export function assColor(hex, alpha = '00') {
  const m = typeof hex === 'string' && hex.match(/^#?([0-9a-fA-F]{6})$/);
  const rr = m ? m[1].slice(0, 2) : 'ff', gg = m ? m[1].slice(2, 4) : 'ff', bb = m ? m[1].slice(4, 6) : 'ff';
  const aa = /^[0-9a-fA-F]{2}$/.test(alpha) ? alpha : '00';
  return `&H${aa}${bb}${gg}${rr}&`.toUpperCase();
}

// opacity 0..1 to the ASS alpha byte (00 = opaque, FF = invisible).
function assAlpha(opacity) {
  const o = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
  return Math.round(255 * (1 - o)).toString(16).padStart(2, '0');
}

const within = (value, low, high, fallback) => Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;

/** A shadow row ({ x, y, blur, spread, colour, opacity }, or null for none) clamped into what the subtitle can draw. */
export function shadowOf(shadow) {
  // null is no shadow at all.
  if (shadow === null) return { x: 0, y: 0, blur: 0, spread: 0, colour: '#000000', opacity: 0 };
  const given = shadow !== null && typeof shadow === 'object' ? shadow : {};
  return {
    x: Math.round(within(given.x, -100, 100, 1)),
    y: Math.round(within(given.y, -100, 100, 1)),
    blur: Math.round(within(given.blur, 0, 50, 0)),
    spread: Math.round(within(given.spread, 0, 100, 0)),
    colour: typeof given.colour === 'string' ? given.colour : '#000000',
    opacity: within(given.opacity, 0, 1, 0.608),
  };
}

// seconds to ASS timestamp H:MM:SS.CS (centiseconds). Clamped to >= 0.
export function assTime(sec) {
  const total = Math.round(Math.max(0, Number.isFinite(sec) ? sec : 0)*100);
  const h = Math.floor(total / 360000), m = Math.floor(total / 6000)%60;
  const whole = Math.floor(total / 100)%60, cs = total%100;
  return `${h}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// escape arbitrary word text into ASS event text: braces open override blocks, backslash is the escape char,
// newlines become \N. Strip other control chars so a transcript word can never break the ASS grammar.
function escapeAssText(t) {
  return String(t == null ? '' : t)
    .replace(/\\/g, '∖')            // set-minus so a literal backslash cannot start an override
    .replace(/[{}]/g, ' ')               // braces would open/close an override block
    .replace(/[\r\n]+/g, '\\N')
    .replace(/[\x00-\x1f\x7f]/g, ' ');   // strip remaining control chars
}

/**
 * Author the full ASS document for a karaoke caption reveal.
 * @param {Array<{start:number,end:number,words:Array<{text:string,start:number,end:number}>}>} lines
 * @param {{highlight?:string, base?:string, outline?:string, font?:string, size?:number, bold?:number,
 *          italic?:boolean, shadow?:{x?:number,y?:number,blur?:number,spread?:number,colour?:string,opacity?:number},
 *          alignment?:number, anchor?:number, marginL?:number, marginR?:number, marginV?:number, outlineW?:number,
 *          playResX?:number, playResY?:number, reveal?:'line'|'karaoke'}} opts
 * @returns {string} ASS subtitle text
 */
export function karaokeAss(lines, opts = {}) {
  const W = Math.max(1, Math.round(opts.playResX ?? 1080));
  const H = Math.max(1, Math.round(opts.playResY ?? 1920));
  // libass fills a syllable with PrimaryColour AS its \k time arrives, showing SecondaryColour before. So the
  // SPOKEN word is Primary (the highlight) and the not-yet-spoken words are Secondary (the base color).
  const primary = assColor(opts.highlight ?? '#ffe000');    // the lit / active word
  const secondary = assColor(opts.base ?? '#ffffff');       // upcoming words
  const outline = assColor(opts.outline ?? '#000000');
  const size = Math.max(1, Math.round(opts.size ?? Math.round(H / 20)));
  const bold = opts.bold === 0 ? 0 : -1;
  const align = Number.isInteger(opts.alignment) ? opts.alignment : 2;   // numpad; 2 = bottom-center
  // Which point of a positioned line (one carrying x and y) sits at that position, numpad; 5 = its centre.
  const anchor = Number.isInteger(opts.anchor) && opts.anchor >= 1 && opts.anchor <= 9 ? opts.anchor : 5;
  const mL = Math.max(0, Math.round(opts.marginL ?? 40));
  const mR = Math.max(0, Math.round(opts.marginR ?? 40));
  const mV = Math.max(0, Math.round(opts.marginV ?? Math.round(H / 8)));
  const outlineW = Math.max(0, Math.round(opts.outlineW ?? 3));
  const italic = opts.italic === true ? -1 : 0;
  const shade = shadowOf(opts.shadow);
  const halo = shade.blur > 0 || shade.spread > 0;
  const shadeColour = assColor(shade.colour, assAlpha(shade.opacity));
  // A plain drop shadow with equal offsets is the style's own Shadow; unequal ones are set on each line.
  const evenDrop = !halo && shade.x === shade.y && shade.x >= 0;
  const shadow = evenDrop ? shade.x : 0;
  const dropOverride = !halo && !evenDrop ? `\\xshad${shade.x}\\yshad${shade.y}` : '';
  const shadeRgb = assColor(shade.colour).replace(/^&H00/, '&H');
  const shadeAlpha = `&H${assAlpha(shade.opacity).toUpperCase()}&`;
  const haloOverride = !halo ? '' : shade.x === 0 && shade.y === 0
    ? `\\1a&HFF&\\2a&HFF&\\3c${shadeRgb}\\3a${shadeAlpha}\\bord${outlineW + shade.spread}\\blur${shade.blur}\\shad0`
    : `\\1a&HFF&\\2a&HFF&\\3a&HFF&\\4c${shadeRgb}\\4a${shadeAlpha}\\bord${outlineW + shade.spread}\\blur${shade.blur}\\xshad${shade.x}\\yshad${shade.y}`;
  const font = String(opts.font ?? 'Arial').replace(/[,\r\n{}]/g, ' ');

  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: K,${font},${size},${primary},${secondary},${outline},${shadeColour},${bold},${italic},0,0,100,100,0,0,1,${outlineW},${shadow},${align},${mL},${mR},${mV},1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = (Array.isArray(lines) ? lines : []).map((line) => {
    const words = Array.isArray(line?.words) && line.words.length
      ? line.words
      : (line?.text ? [{ text: line.text, start: line.start, end: line.end }] : []);
    if (!words.length) return '';
    const beginning=Math.round((line.start??words[0].start??0)*100);
    let cursor=beginning;
    // A line shown whole keeps its own text as written (its spacing and punctuation); a karaoke line is its words.
    const text = opts.reveal==='line'?escapeAssText(typeof line.text==='string'&&line.text.trim()?line.text:words.map(w=>w.text).join(' ')):words.map((w,index) => {
      const start=Math.max(cursor,Math.round((w.start??0)*100));
      const end=Math.max(start,Math.round((words[index+1]?.start??w.end??w.start??0)*100));
      const delay=start>cursor?`{\\k${start-cursor}}\u200b`:'';
      cursor=end;
      return `${delay}{\\k${end-start}}${escapeAssText(w.text)}`;
    }).join(' ');
    const start = assTime(line.start ?? words[0].start);
    const end = assTime(line.end ?? words[words.length - 1].end);
    const position=Number.isFinite(line.x)&&Number.isFinite(line.y)?`\\an${anchor}\\pos(${Math.round(Math.max(0,Math.min(1,line.x))*W)},${Math.round(Math.max(0,Math.min(1,line.y))*H)})`:'';
    const wordsEvent=`Dialogue: ${halo?1:0},${start},${end},K,,0,0,0,,${position||dropOverride?`{${position}${dropOverride}}`:''}${text}`;
    // The halo is the same text on the layer beneath, so it sits exactly under every word as they light up.
    return halo?`Dialogue: 0,${start},${end},K,,0,0,0,,{${position}${haloOverride}}${text}\n${wordsEvent}`:wordsEvent;
  }).filter(Boolean);

  return head + events.join('\n') + '\n';
}

// CLI: node author-karaoke-captions.mjs --lines '<json>' [--highlight #hex --base #hex --size N --width W --height H]
// Prints the ASS string. `--lines` is the caption-lines output ([{start,end,words:[{text,start,end}]}]).
// The page imports this author too (the editor's captions), where there is no command line to read.
if (globalThis.process?.argv && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = {}; let lines = [];
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i], v = args[i + 1];
    if (k === '--lines') lines = JSON.parse(v);
    else if (k === '--highlight') opt.highlight = v;
    else if (k === '--base') opt.base = v;
    else if (k === '--size') opt.size = Number(v);
    else if (k === '--width') opt.playResX = Number(v);
    else if (k === '--height') opt.playResY = Number(v);
    else if (k === '--align') opt.alignment = Number(v);
  }
  if (!Array.isArray(lines) || !lines.length) { console.error('usage: author-karaoke-captions.mjs --lines \'[{"start":0,"end":2,"words":[{"text":"hi","start":0,"end":1}]}]\' [--highlight #hex --base #hex --size N --width W --height H]'); process.exit(2); }
  process.stdout.write(karaokeAss(lines, opt));
}
