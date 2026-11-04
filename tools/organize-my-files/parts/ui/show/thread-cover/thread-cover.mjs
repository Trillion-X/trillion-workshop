// parts/ui/show/thread-cover/thread-cover.mjs
//
// Purpose: what covers Trillion while it opens, the same everywhere (the web page, the iPhone app, the Mac app, the
// Chrome extension): the landing page's red thread, pulled by the logo's needle. The thread lies strewn about; the
// needle pulls it in until it bunches up into a ball, pulls it out straight, then moves off again drawing thread all
// over the place, over and over, always heading the way it moves; a quote stands in the middle, a different one each time;
// when Trillion is ready the cover lifts away through a dissolving gradient mesh.
//
// Non-negotiable invariants:
// 1. The cover is its own opaque layer over the whole window (position fixed, inset 0, its own paper, above
//    everything): nothing behind it shows until it dissolves.
// 2. It is drawn from the page's first bytes: `threadCoverHtml()` writes its element, its rules and its script inline,
//    so it paints before any script file arrives and the page waits on nothing for it. The app lifts it with
//    `window.trillionCover.lift()` the moment it is ready, so it shows only while Trillion is genuinely opening.
// 3. The drawing is the landing page's: the ball and the curve are ../scroll-thread/thread-geometry.mjs, the needle is
//    the logo's needle (public/brand/trillion-needle.svg). Words, timing and colours are DATA (./thread-cover.json).
// 4. `runThreadCover` is whole in itself (it reads only its arguments), so it travels into the page as text.
// 5. A host app that draws the cover itself (the iPhone app, before its page has any bytes) sets
//    `window.__trillionCoverHost` before the page runs: the page then draws nothing and `lift()` tells the host
//    (webkit message `trillionCover`), which dissolves its own cover, so one cover plays from launch to ready; the host
//    calls `window.trillionCover.lifted()` once its cover is gone, which settles `lift()`, as on every other surface.
// 6. With reduced motion the thread lies straight and still, and the cover fades instead of dissolving.
// 7. The cover element is the custom element `trillion-cover`: one name every surface styles and finds.
// 8. Once lift is requested, its dissolve ends within its configured duration even when the host suspends animation
//    frames. Finishing removes the cover once and cancels its pending work; it does not change account readiness.

import { curve, random, tangle } from '../scroll-thread/thread-geometry.mjs';
import setup from './thread-cover.json' with { type: 'json' };

/** Draws the cover into `root` and plays it; returns `{ lift() }`, which dissolves the cover and removes `root`.
 *  `geometry` is `{ random, tangle, curve }` from thread-geometry.mjs; `settings` is thread-cover.json.
 *  @param {{random: Function, tangle: Function, curve: Function}} geometry @param {HTMLElement} root @param {any} settings
 *  @returns {{ lift(): Promise<void> }} */
export function runThreadCover(geometry, root, settings) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const NS = 'http://www.w3.org/2000/svg';
  const look = settings.look;
  const timing = settings.timing_ms;
  const still = Boolean(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // The logo's needle and where the thread lies (thread-cover.json needle and layout).
  const needleRow = settings.needle;
  const layout = settings.layout;

  const shape = (tag, attributes) => {
    const made = doc.createElementNS(NS, tag);
    for (const name of Object.keys(attributes)) made.setAttribute(name, attributes[name]);
    return made;
  };
  root.setAttribute('role', 'status');
  root.setAttribute('aria-label', settings.label);
  const mesh = doc.createElement('i');
  mesh.className = 'trillion-cover__mesh';
  const drawing = shape('svg', { class: 'trillion-cover__thread', 'aria-hidden': 'true', focusable: 'false' });
  const line = shape('path', { fill: 'none', stroke: look.thread, 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const second = shape('path', { fill: 'none', stroke: look.thread, 'stroke-width': '1.4', 'stroke-linecap': 'round', opacity: '0.7' });
  const needle = shape('path', { d: needleRow.path, fill: look.ink });
  drawing.append(line, second, needle);
  // A different quote from the one this device showed last time.
  const quotes = settings.quotes;
  let last = -1;
  try { last = Number(win.localStorage.getItem('trillion-cover-quote') ?? -1); } catch { last = -1; }
  let chosen = Math.floor(Math.random() * quotes.length);
  if (quotes.length > 1 && chosen === last) chosen = (chosen + 1 + Math.floor(Math.random() * (quotes.length - 1))) % quotes.length;
  try { win.localStorage.setItem('trillion-cover-quote', String(chosen)); } catch { /* without storage the next quote may repeat */ }
  const figure = doc.createElement('figure');
  figure.className = 'trillion-cover__quote';
  const words = doc.createElement('blockquote');
  words.textContent = quotes[chosen].words;
  const by = doc.createElement('figcaption');
  by.textContent = quotes[chosen].by;
  figure.append(words, by);
  root.append(mesh, drawing, figure);

  let width = 0;
  let height = 0;
  let row = 0;
  // How long the needle is drawn, and the span the thread is pulled across so the needle never leaves the window.
  let needlePx = 0;
  let left = 0;
  let right = 0;
  // The thread is drawn through the same number of points in every part of the loop, so each part flows into the next:
  // pulled straight (`straight`), the landing page's ball (`ball`), strewn about (a new path each time round).
  const thread = settings.thread;
  const count = thread.points;
  let straight = [];
  let ball = [];
  let strewnRound = -1;
  let strewnNow = [];
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  // `count` points evenly along the smooth curve thread-geometry's `curve` draws through `points`, so a shape keeps
  // its exact look when drawn through more points.
  const along = (points) => Array.from({ length: count }, (_, index) => {
    const reach = (index / (count - 1)) * (points.length - 1);
    const at = Math.min(Math.floor(reach), points.length - 2);
    const t = reach - at;
    const p0 = points[at - 1] ?? points[at];
    const p1 = points[at];
    const p2 = points[at + 1];
    const p3 = points[at + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    const u = 1 - t;
    return {
      x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
      y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
    };
  });
  const measure = () => {
    width = root.clientWidth || win.innerWidth;
    height = root.clientHeight || win.innerHeight;
    row = height * layout.row;
    needlePx = Math.max(layout.needle_min, Math.min(width, height) * layout.needle_share);
    left = width * layout.left;
    right = width * layout.right - needlePx * layout.needle_back;
    drawing.setAttribute('viewBox', `0 0 ${width} ${height}`);
    straight = Array.from({ length: count }, (_, index) => ({ x: left + ((right - left) * index) / (count - 1), y: row }));
    // The ball ends at its centre, where the needle rests while the thread is bunched up.
    ball = along(geometry.tangle({ x: width / 2, y: row }, Math.min(width, height) * 0.09, geometry.random(7)));
    strewnRound = -1;
  };
  measure();
  // Where the needle wanders as it draws: from the straight thread's end it steers through `thread.strewn_turns`
  // places spread across `thread.strewn_area` (each column of it once, in a random order, high and low in turn),
  // turning no tighter than `thread.strewn_bend` of the window's short side, so the thread it leaves sweeps and loops
  // all over the place, never across the quote.
  const strewn = (seed) => {
    const next = geometry.random(seed);
    const area = thread.strewn_area;
    const turns = thread.strewn_turns;
    const columns = Array.from({ length: turns }, (_, index) => index);
    for (let index = turns - 1; index > 0; index -= 1) {
      const other = Math.floor(next() * (index + 1));
      [columns[index], columns[other]] = [columns[other], columns[index]];
    }
    const places = columns.map((column, index) => ({
      x: width * (area.left + (area.right - area.left) * ((column + 0.2 + next() * 0.6) / turns)),
      y: height * (area.top + (area.bottom - area.top) * ((index % 2 === 0 ? 0 : 0.7) + next() * 0.3)),
    }));
    const short = Math.min(width, height);
    const bend = short * thread.strewn_bend;
    const step = short * 0.008;
    const most = step / bend;
    let at = { x: right, y: row };
    let heading = -Math.PI * (0.5 + next() * 0.3);
    const sway = next() * Math.PI * 2;
    const path = [at];
    for (let place = 0; place < places.length && path.length < 6000;) {
      const goal = places[place];
      const toward = Math.atan2(goal.y - at.y, goal.x - at.x) - heading;
      // A gentle sway on top, so a long run between two places still curves like dropped thread.
      heading += clamp(Math.atan2(Math.sin(toward), Math.cos(toward)), -most, most) + Math.sin(path.length * 0.05 + sway) * most * 0.6;
      at = { x: at.x + Math.cos(heading) * step, y: at.y + Math.sin(heading) * step };
      path.push(at);
      if (Math.hypot(goal.x - at.x, goal.y - at.y) < bend * 1.4) place += 1;
    }
    // `count` points evenly along the path.
    const reached = [0];
    for (let index = 1; index < path.length; index += 1) reached.push(reached[index - 1] + Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y));
    const length = reached[reached.length - 1];
    let walk = 0;
    return Array.from({ length: count }, (_, index) => {
      const want = (length * index) / (count - 1);
      while (walk < path.length - 2 && reached[walk + 1] < want) walk += 1;
      const span = reached[walk + 1] - reached[walk] || 1;
      return mix(path[walk], path[walk + 1], clamp((want - reached[walk]) / span, 0, 1));
    });
  };
  const strewnFor = (round) => {
    if (round !== strewnRound) { strewnRound = round; strewnNow = strewn(round + 11); }
    return strewnNow;
  };
  const ease = (value) => (value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2);
  const smooth = (value) => value * value * (3 - 2 * value);
  const mix = (from, to, share) => ({ x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share });
  // How far point `index` has gone at `share` of a pull: the needle's end of the thread goes first, the far end follows.
  const lag = (share, index, reach) => clamp(share * (1 + reach) - (1 - index / (count - 1)) * reach, 0, 1);
  const loop = timing.draw + timing.gather + timing.hold + timing.straighten + timing.rest;
  // The loop starts at the straight thread (the rest), the frame a host app draws natively before this page paints.
  const startAt = loop - timing.rest;
  const pointsAt = (time) => {
    const total = time + startAt;
    const scattered = strewnFor(Math.floor(total / loop));
    let at = total % loop;
    if (at < timing.draw) {
      // The needle draws: the thread follows its eye, off the straight line and along the new path.
      const trail = (index) => (index < count ? straight[index] : scattered[index - count + 1]);
      const moved = ease(at / timing.draw) * (count - 1);
      return Array.from({ length: count }, (_, index) => {
        const reach = moved + index;
        const before = Math.floor(reach);
        return mix(trail(before), trail(Math.min(before + 1, 2 * count - 2)), reach - before);
      });
    }
    at -= timing.draw;
    if (at < timing.gather) {
      // The needle pulls the strewn thread in and it bunches up into the ball.
      const share = ease(at / timing.gather);
      return scattered.map((point, index) => mix(point, ball[index], smooth(lag(share, index, 0.6))));
    }
    at -= timing.gather;
    if (at < timing.hold) return ball;
    at -= timing.hold;
    if (at < timing.straighten) {
      // The needle pulls it out straight, settling onto the row before its last stretch to the right.
      const share = ease(at / timing.straighten);
      return ball.map((point, index) => {
        const own = lag(share, index, 0.5);
        return { x: point.x + (straight[index].x - point.x) * smooth(own), y: point.y + (row - point.y) * smooth(Math.min(1, own * 1.4)) };
      });
    }
    return straight;
  };
  const through = (points) => `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} ${geometry.curve(points, new Set()).join(' ')}`;
  // The needle heads the way its eye is moving, turning smoothly; while it stands still it keeps its heading.
  let heading = 0;
  let headWas = null;
  let headAt = 0;
  const steer = (head, time) => {
    if (headWas) {
      const spent = Math.max(1, time - headAt);
      const dx = head.x - headWas.x;
      const dy = head.y - headWas.y;
      if (Math.hypot(dx, dy) / spent > needleRow.turns_above_px_per_ms) {
        const toward = Math.atan2(dy, dx) - heading;
        heading += Math.atan2(Math.sin(toward), Math.cos(toward)) * Math.min(1, spent / needleRow.turn_ms);
      }
    }
    headWas = head;
    headAt = time;
  };
  const draw = (points, time) => {
    line.setAttribute('d', through(points));
    second.setAttribute('d', through(points.map((point, index) => ({ x: point.x + Math.sin(index * 2.3) * 1.4, y: point.y + Math.cos(index * 1.7) * 1.4 }))));
    // The needle leads: its eye on the thread's last point.
    const head = points[points.length - 1];
    steer(head, time);
    const size = needlePx / needleRow.length;
    needle.setAttribute('transform', `translate(${head.x.toFixed(1)} ${head.y.toFixed(1)}) rotate(${((heading * 180) / Math.PI - needleRow.points_along).toFixed(1)}) scale(${size.toFixed(2)}) translate(${-needleRow.eye.x} ${-needleRow.eye.y})`);
  };
  let frame = 0;
  const began = win.performance.now();
  const play = () => {
    const time = win.performance.now() - began;
    draw(pointsAt(time), time);
    frame = win.requestAnimationFrame(play);
  };
  if (still) draw(straight, 0); else play();
  const resized = () => { measure(); headWas = null; if (still) draw(straight, 0); };
  win.addEventListener('resize', resized);

  let lifting = null;
  return {
    lift() {
      if (lifting) return lifting;
      lifting = new Promise((done) => {
        // Trillion beneath takes every touch from the moment the cover starts to go.
        root.style.pointerEvents = 'none';
        let finished = false;
        let dissolveFrame = 0;
        let deadline = 0;
        const finish = () => {
          if (finished) return;
          finished = true;
          win.clearTimeout(deadline);
          win.cancelAnimationFrame(frame);
          if (dissolveFrame) win.cancelAnimationFrame(dissolveFrame);
          win.removeEventListener('resize', resized);
          root.remove();
          done();
        };
        // A background WebKit view may suspend frames. A requested lift must still settle, or the page's opening
        // bound waits forever for this animation despite having drawn its content or failure state beneath it.
        deadline = win.setTimeout(finish, still ? 220 : timing.dissolve);
        if (still) {
          root.style.transition = 'opacity 200ms ease';
          root.style.opacity = '0';
          return;
        }
        // The mesh: soft colour fields bloom over the paper, then a hole opens from each and together they swallow
        // the whole cover, showing Trillion beneath.
        const fields = look.mesh.map((colour, index) => ({ colour, x: 12 + ((index * 37) % 78), y: 16 + ((index * 53) % 70) }));
        mesh.style.background = fields.map((field) => `radial-gradient(circle at ${field.x}% ${field.y}%, ${field.colour} 0%, transparent 48%)`).join(', ');
        root.style.webkitMaskComposite = 'source-in';
        root.style.maskComposite = 'intersect';
        const begun = win.performance.now();
        const step = () => {
          if (finished) return;
          const share = Math.min(1, (win.performance.now() - begun) / timing.dissolve);
          mesh.style.opacity = String(Math.min(1, share * 3));
          // Each field opens a little after the one before, so the cover melts away one bloom at a time.
          const holes = fields.map((field, index) => {
            const own = Math.min(1, Math.max(0, (share - index * 0.08) / (1 - (fields.length - 1) * 0.08)));
            const reach = own * own * 110;
            return `radial-gradient(circle at ${field.x}% ${field.y}%, transparent ${reach.toFixed(1)}%, #000 ${(reach + 18).toFixed(1)}%)`;
          }).join(', ');
          root.style.webkitMaskImage = holes;
          root.style.maskImage = holes;
          if (share < 1) dissolveFrame = win.requestAnimationFrame(step); else finish();
        };
        dissolveFrame = win.requestAnimationFrame(step);
      });
      return lifting;
    },
  };
}

/** The cover's rules: its own opaque layer over everything, the thread and needle, the quote in the middle. */
export function threadCoverCss(look = setup.look) {
  return `trillion-cover{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;overflow:hidden;`
    + `background:${look.paper};color:${look.ink}}`
    + '.trillion-cover__mesh{position:absolute;inset:0;opacity:0;pointer-events:none}'
    + '.trillion-cover__thread{position:absolute;inset:0;width:100%;height:100%;overflow:visible}'
    + '.trillion-cover__quote{position:relative;margin:0;padding:0 1.5rem;max-width:34rem;text-align:center;transform:translateY(9vh)}'
    + `.trillion-cover__quote blockquote{margin:0;font-family:${look.quote_font};font-size:clamp(1.15rem,2.6vw,1.6rem);line-height:1.45}`
    + `.trillion-cover__quote figcaption{margin-top:.9rem;font-family:${look.by_font};font-size:.8125rem;color:${look.quiet}}`;
}

/** The cover as the first bytes of a page body: its element, rules and script, which draw it before any file arrives
 *  and set `window.trillionCover`. When a host app draws the cover (invariant 5) the page removes its own at once. */
export function threadCoverHtml(settings = setup) {
  const data = JSON.stringify(settings).replace(/</g, '\\u003c');
  const script = '(function(){var root=document.querySelector("trillion-cover");if(!root)return;'
    // Under a host app, lift() settles once the host says its own cover has finished dissolving (`lifted()`), or after
    // the dissolve's own time and a margin if the host never says.
    + 'if(window.__trillionCoverHost){root.remove();var gone,after=new Promise(function(done){gone=done});'
    + 'window.trillionCover={lifted:function(){gone()},lift:function(){try{window.webkit.messageHandlers.trillionCover.postMessage("ready")}catch(e){gone()}'
    + `setTimeout(gone,${settings.timing_ms.dissolve + 1500});return after}};return}`
    + `var geometry={random:${random},tangle:${tangle},curve:${curve}};`
    + `window.trillionCover=(${runThreadCover})(geometry,root,${data})})();`;
  return `<style>${threadCoverCss(settings.look)}</style><trillion-cover></trillion-cover><script>${script}</script>`;
}

/** The needle alone as a picture, pointing right with its eye at the centre: what a host app draws natively for the
 *  cover's first frame (the straight thread). The picture is 2.2 needle lengths square, so drawn `2.2 * needlePx` wide
 *  and centred on the thread's end it matches the page's needle exactly. */
export function coverNeedleSvg(settings = setup) {
  const { needle, look } = settings;
  const half = needle.length * 1.1;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-half} ${-half} ${half * 2} ${half * 2}">`
    + `<path transform="rotate(${-needle.points_along}) translate(${-needle.eye.x} ${-needle.eye.y})" fill="${look.ink}" d="${needle.path}"/></svg>\n`;
}

/** The cover as a whole page by itself: a host app's own cover, drawn before its real page has any bytes. The page
 *  behind the cover is clear, so as the cover dissolves the host shows what is under it. `look` is the screen look the
 *  page wears without a stylesheet: `faces` (the @font-face rules of the faces it names) and `palette` (its variables,
 *  so the quote is set in the look's display face like every other page). */
export function threadCoverPage(settings = setup, look = { faces: '', palette: {} }) {
  const variables = Object.entries(look.palette).map(([name, value]) => `${name}:${value}`).join(';');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"/>'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>'
    + `<style>${look.faces}:root{${variables}}html,body{margin:0;padding:0;background:transparent}</style></head><body>${threadCoverHtml(settings)}</body></html>`;
}

/** Draws the cover over a page that already runs scripts (the Chrome extension's windows); returns `{ lift() }`. */
export function mountThreadCover(doc = document, settings = setup) {
  if (!doc.getElementById('trillion-cover-rules')) {
    const rules = doc.createElement('style');
    rules.id = 'trillion-cover-rules';
    rules.textContent = threadCoverCss(settings.look);
    doc.head.append(rules);
  }
  const root = doc.createElement('trillion-cover');
  doc.body.append(root);
  return runThreadCover({ random, tangle, curve }, root, settings);
}
