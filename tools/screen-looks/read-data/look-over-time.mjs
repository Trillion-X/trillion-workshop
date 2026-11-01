// tools/screen-looks/read-data/look-over-time.mjs
//
// PURPOSE
//   A screen look that changes over the day: which look a screen wears at any moment from the app owner's plan (points
//   in the day, each a moment by the clock or by the sun), and the look itself at that moment, blended value by value
//   between the two looks around it. Worked out wherever the screen is drawn, so the change costs nothing and writes
//   nothing while it happens, and follows the time zone the device is in.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no page, no records, no clock of its own. The caller hands in the plan, the moment, the device's zone and
//      the app-owned settings DATA.
//   2. Blind: nothing here names a look, a colour or a time of day; looks are ids from the plan, anchors and starting
//      plans are rows of the settings DATA, and a blend treats every value the same way (colours mixed, numbers moved,
//      anything else switched halfway).
//   3. A point that cannot be placed on a day (a sun anchor with no place, a day the sun never gets there) is left out
//      of that day, never guessed.
//   4. The same plan, moment and settings give the same answer on every device and on the server.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { parseColour, toLinear, colourOf, contrast, screenLookScheme } from './look-scheme.mjs';
import { timeZoneName } from './look-time-zone.js';
export { colourOf, contrast, screenLookScheme };
const MINUTE = 60_000;
const DAY = 86_400_000;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
// ---------------------------------------------------------------------------------------------------------------------
// Time in a zone
// ---------------------------------------------------------------------------------------------------------------------

const formatters = new Map();
function wallOf(instant, zone) {
    let format = formatters.get(zone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric'
        });
        formatters.set(zone, format);
    }
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part)=>[
            part.type,
            part.value
        ]));
    return {
        y: Number(parts.year),
        m: Number(parts.month),
        d: Number(parts.day),
        h: Number(parts.hour) % 24,
        min: Number(parts.minute),
        s: Number(parts.second)
    };
}
/** Minutes the zone's wall clock is ahead of UTC at `instant`. */
function offsetMinutes(instant, zone) {
    const w = wallOf(instant, zone);
    return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(instant / 1000) * 1000) / MINUTE);
}
/** The instant a wall-clock time on a local date happens in the zone (the later of two on a clock change's repeat). */
function instantOfWall(y, m, d, h, min, zone) {
    const guess = Date.UTC(y, m - 1, d, h, min);
    const first = guess - offsetMinutes(guess, zone) * MINUTE;
    return guess - offsetMinutes(first, zone) * MINUTE;
}
/** The zone this device is in, where a plan with no zone of its own is read. */
export const deviceZone = ()=>Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
/** The start of the day `instant` falls in, in `zone`, as an instant. */
export function startOfDay(instant, zone) {
    const wall = wallOf(instant, zone);
    return instant - ((wall.h * 60 + wall.min) * 60 + wall.s) * 1000 - instant % 1000;
}
export function isTimeZone(zone) {
    return timeZoneName(zone) !== null;
}
// ---------------------------------------------------------------------------------------------------------------------
// The sun (the standard low-precision solar position formulae: mean anomaly, ecliptic longitude, declination and the
// hour angle at an altitude), good to about a minute, enough for a screen to follow the evening.
// ---------------------------------------------------------------------------------------------------------------------

const RAD = Math.PI / 180;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const OBLIQUITY = RAD * 23.4397;
const toDays = (ms)=>ms / DAY - 0.5 + J1970 - J2000;
const fromJulian = (j)=>(j + 0.5 - J1970) * DAY;
/** When the sun crosses `altitude` degrees, rising or setting, on the day around `aroundMs`, at the place; null when it
 *  does not cross it that day (polar day or night). */
export function sunCrossing(aroundMs, place, altitude, side) {
    const lw = RAD * -place.longitude;
    const phi = RAD * place.latitude;
    const n = Math.round(toDays(aroundMs) - J0 - lw / (2 * Math.PI));
    const ds = J0 + lw / (2 * Math.PI) + n;
    const M = RAD * (357.5291 + 0.98560028 * ds);
    const L = M + RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + RAD * 102.9372 + Math.PI;
    const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
    const transit = (a)=>J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const cosW = (Math.sin(altitude * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (!(cosW >= -1 && cosW <= 1)) return null;
    const w = Math.acos(cosW);
    const noon = transit(ds);
    const set = transit(J0 + (w + lw) / (2 * Math.PI) + n);
    return fromJulian(side === 'setting' ? set : noon - (set - noon));
}
// ---------------------------------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------------------------------

const anchorOf = (id, settings)=>settings.anchors.find((row)=>row.id === id) ?? null;
/** Each point placed on the local day `y-m-d` in the zone, as an instant; points that cannot be placed that day are
 *  left out. */
function placeOnDay(points, y, m, d, zone, place, settings) {
    const out = [];
    for (const point of points){
        if ('clock' in point.at) {
            const [, h, min] = CLOCK.exec(point.at.clock) ?? [];
            if (h !== undefined) out.push({
                at: instantOfWall(y, m, d, Number(h), Number(min), zone),
                look: point.look
            });
            continue;
        }
        const anchor = anchorOf(point.at.anchor, settings);
        if (!anchor || !place) continue;
        const noon = instantOfWall(y, m, d, 12, 0, zone);
        const crossing = sunCrossing(noon, place, anchor.sun.altitude, anchor.sun.side);
        if (crossing !== null) out.push({
            at: crossing + (point.at.minutes ?? 0) * MINUTE,
            look: point.look
        });
    }
    return out;
}
const ease = (t)=>t * t * (3 - 2 * t);
/** Which looks the plan has the screen between at `now` in the device's zone (or the plan's own), or null when the plan
 *  is off or no point can be placed. A hold whose time has not come keeps the look it holds. */
export function lookAtTime(plan, now, deviceZone, settings) {
    if (!plan?.on || !plan.points.length) return null;
    const zone = isTimeZone(plan.time_zone) ? plan.time_zone : deviceZone;
    const at = now.getTime();
    const hold = plan.hold && holdEnds(plan, plan.hold, deviceZone, settings) > at ? plan.hold : null;
    if (hold?.kind === 'frozen') {
        const frozen = lookAtTime({
            ...plan,
            hold: null
        }, new Date(hold.at), deviceZone, settings);
        return frozen ? {
            ...frozen,
            held: hold
        } : null;
    }
    const today = wallOf(at, zone);
    const placed = [];
    for (const offset of [
        -1,
        0,
        1
    ]){
        const day = wallOf(Date.UTC(today.y, today.m - 1, today.d, 12) + offset * DAY, 'UTC');
        placed.push(...placeOnDay(plan.points, day.y, day.m, day.d, zone, plan.place, settings));
    }
    placed.sort((a, b)=>a.at - b.at);
    const before = placed.filter((point)=>point.at <= at).at(-1);
    const after = placed.find((point)=>point.at > at);
    if (!before || !after) return null;
    const t = after.at === before.at ? 1 : ease((at - before.at) / (after.at - before.at));
    return {
        from: before.look,
        to: after.look,
        t,
        since: new Date(before.at),
        next: new Date(after.at),
        held: hold
    };
}
/** When a hold ends: its own `until`, or the plan's next point after the hold began. */
export function holdEnds(plan, hold, deviceZone, settings) {
    if (hold.until) return Date.parse(hold.until);
    const began = hold.kind === 'worn' ? hold.since : hold.at;
    return nextPointAfter(plan, new Date(began), deviceZone, settings)?.getTime() ?? 0;
}
/** The moment of the next point after `now`, or null: when a hold until the next change ends. */
export function nextPointAfter(plan, now, deviceZone, settings) {
    return lookAtTime(plan ? {
        ...plan,
        on: true,
        hold: null
    } : plan, now, deviceZone, settings)?.next ?? null;
}
/** A stored plan read back whole (anything it cannot use is dropped), or null when there is none. */
export function readLookPlan(value, settings) {
    if (!value || typeof value !== 'object') return null;
    const row = value;
    const points = (Array.isArray(row.points) ? row.points : []).map((point)=>readPoint(point, settings)).filter((point)=>!!point);
    const place = readPlace(row.place);
    const hold = readHold(row.hold);
    return {
        on: row.on === true,
        points,
        place,
        time_zone: isTimeZone(row.time_zone) ? row.time_zone : null,
        hold,
        preset: typeof row.preset === 'string' ? row.preset : null
    };
}
function readPoint(value, settings) {
    if (!value || typeof value !== 'object') return null;
    const { at, look } = value;
    if (typeof look !== 'string' || !look.trim() || !at || typeof at !== 'object') return null;
    if (typeof at.clock === 'string' && CLOCK.test(at.clock)) return {
        at: {
            clock: at.clock
        },
        look: look.trim()
    };
    if (typeof at.anchor === 'string' && anchorOf(at.anchor, settings)) {
        const minutes = Number(at.minutes ?? 0);
        return {
            at: {
                anchor: at.anchor,
                minutes: Number.isFinite(minutes) ? Math.max(-720, Math.min(720, Math.round(minutes))) : 0
            },
            look: look.trim()
        };
    }
    return null;
}
function readPlace(value) {
    if (!value || typeof value !== 'object') return null;
    const { latitude, longitude } = value;
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    // Kept to a tenth of a degree (about 10 km): enough for the sun, and no closer to where the person is.
    return {
        latitude: Math.round(lat * 10) / 10,
        longitude: Math.round(lon * 10) / 10
    };
}
const isMoment = (value)=>typeof value === 'string' && Number.isFinite(Date.parse(value));
function readHold(value) {
    if (!value || typeof value !== 'object') return null;
    const row = value;
    if (row.until !== undefined && !isMoment(row.until)) return null;
    const until = isMoment(row.until) ? {
        until: row.until
    } : {};
    if (row.kind === 'worn' && isMoment(row.since)) return {
        kind: 'worn',
        since: row.since,
        ...until
    };
    if (row.kind === 'frozen' && isMoment(row.at)) return {
        kind: 'frozen',
        at: row.at,
        ...until
    };
    return null;
}
/** A change to a plan checked the way the person's tools and screens all check it: points within the limit, each look
 *  one the person can wear (`looks`), a preset replacing the points with its own. Throws plain words when it cannot. */
export function changeLookPlan(current, change, looks, settings) {
    const base = current ?? {
        on: false,
        points: [],
        place: null,
        time_zone: null,
        hold: null,
        preset: null
    };
    const next = {
        ...base
    };
    if (typeof change.preset === 'string' && change.preset) {
        const preset = settings.presets.find((row)=>row.id === change.preset);
        if (!preset) throw new Error(`There is no plan called ${change.preset}. The starting plans are ${settings.presets.map((row)=>row.id).join(', ')}.`);
        next.points = preset.points.map((point)=>({
                ...point
            }));
        next.preset = preset.id;
        next.on = true;
        next.hold = null;
    }
    if (change.points !== undefined) {
        if (!Array.isArray(change.points)) throw new Error('points is a list of { at, look }.');
        const points = change.points.map((point)=>readPoint(point, settings));
        const bad = points.findIndex((point)=>!point);
        if (bad >= 0) throw new Error(`Point ${bad + 1} needs at as { clock: "HH:MM" } or { anchor: ${settings.anchors.map((row)=>`"${row.id}"`).join(' | ')}, minutes }, and a look.`);
        if (points.length > settings.most_points) throw new Error(`A plan holds at most ${settings.most_points} points.`);
        next.points = points;
        next.preset = null;
        next.hold = null;
    }
    if (change.place !== undefined) next.place = change.place === null ? null : readPlace(change.place);
    if (change.place && !next.place) throw new Error('place is { latitude, longitude } in degrees.');
    if (change.time_zone !== undefined) {
        if (change.time_zone !== null && !isTimeZone(change.time_zone)) throw new Error(`${String(change.time_zone)} is not a time zone; use one like America/Los_Angeles.`);
        next.time_zone = change.time_zone ?? null;
    }
    if (change.hold !== undefined) {
        next.hold = change.hold === null ? null : readHold(change.hold);
        if (change.hold !== null && !next.hold) throw new Error('hold is { kind: "worn", since } or { kind: "frozen", at }, with an optional until, each a date and time.');
    }
    if (typeof change.on === 'boolean') next.on = change.on;
    const unknown = [
        ...new Set(next.points.map((point)=>point.look).filter((id)=>!looks.includes(id)))
    ];
    if (unknown.length) throw new Error(`There is no look ${unknown.join(', ')}. The looks are ${looks.join(', ')}.`);
    if (next.on && !next.points.length) throw new Error('A plan needs at least one point before it can be on.');
    return next;
}
/** A plan in words, for the person and their AIs: each point's moment and look, by the looks' names. */
export function sayLookPlan(plan, nameOf, settings) {
    if (!plan?.points.length) return 'No look plan yet.';
    const moment = (at)=>{
        if ('clock' in at) return at.clock;
        const anchor = anchorOf(at.anchor, settings)?.label ?? at.anchor;
        const minutes = at.minutes ?? 0;
        return minutes ? `${Math.abs(minutes)} min ${minutes < 0 ? 'before' : 'after'} ${anchor.toLowerCase()}` : anchor.toLowerCase();
    };
    const points = plan.points.map((point)=>`${moment(point.at)} ${nameOf(point.look)}`).join(', ');
    return `Look plan ${plan.on ? 'on' : 'off'}: ${points}.${plan.hold ? ` Held until ${plan.hold.until ?? 'the next point'}.` : ''}`;
}
// ---------------------------------------------------------------------------------------------------------------------
// Blending two looks
// ---------------------------------------------------------------------------------------------------------------------

const PIECE = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|-?\d*\.?\d+/gi;
const fromLinear = (v)=>255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);
function toOklab([r, g, b]) {
    const [lr, lg, lb] = [
        toLinear(r),
        toLinear(g),
        toLinear(b)
    ];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    ];
}
function fromOklab([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ];
    return rgb.map((v)=>Math.round(Math.min(255, Math.max(0, fromLinear(v)))));
}
const round = (n)=>Math.round(n * 1000) / 1000;
function mixColour(a, b, t) {
    const [la, lb] = [
        toOklab(a),
        toOklab(b)
    ];
    const [r, g, bl] = fromOklab([
        0,
        1,
        2
    ].map((i)=>la[i] + (lb[i] - la[i]) * t));
    const alpha = round(a[3] + (b[3] - a[3]) * t);
    return alpha >= 1 ? `rgb(${r}, ${g}, ${bl})` : `rgba(${r}, ${g}, ${bl}, ${alpha})`;
}
/** One value at `t` between `a` and `b`: when both are the same text around the same kinds of colours and numbers,
 *  each colour and number moves; otherwise it switches halfway. */
export function blendValue(a, b, t) {
    if (a === b || t <= 0) return a;
    if (t >= 1) return b;
    const piecesA = a.match(PIECE) ?? [];
    const piecesB = b.match(PIECE) ?? [];
    if (a.replace(PIECE, '\u0000') !== b.replace(PIECE, '\u0000') || piecesA.length !== piecesB.length) return t < 0.5 ? a : b;
    const mixed = [];
    for(let i = 0; i < piecesA.length; i += 1){
        const [pa, pb] = [
            piecesA[i],
            piecesB[i]
        ];
        const colourA = /^#|^rgb/i.test(pa) ? parseColour(pa) : null;
        const colourB = /^#|^rgb/i.test(pb) ? parseColour(pb) : null;
        if (colourA && colourB) {
            mixed.push(mixColour(colourA, colourB, t));
            continue;
        }
        if (colourA || colourB) return t < 0.5 ? a : b;
        mixed.push(String(round(Number(pa) + (Number(pb) - Number(pa)) * t)));
    }
    let i = 0;
    return a.replace(PIECE, ()=>mixed[i++]);
}
/** A colour as it shows over `ground`: a see-through colour mixed with what is under it. */
export const over = ([r, g, b, alpha], [gr, gg, gb])=>[
        r * alpha + gr * (1 - alpha),
        g * alpha + gg * (1 - alpha),
        b * alpha + gb * (1 - alpha),
        1
    ];
/** Two looks' values (CSS variable to value) at `t` between them. A colour readable over its look's ground in both
 *  looks (`keep_readable`; a see-through colour judged as it shows over that ground) that would fade into the blended
 *  ground shows as whichever of its two colours reads better there, so words never pass through grey on grey. */
export function blendLookValues(a, b, t, settings) {
    const out = {};
    for (const key of new Set([
        ...Object.keys(a),
        ...Object.keys(b)
    ])){
        const [va, vb] = [
            a[key],
            b[key]
        ];
        out[key] = va === undefined ? vb : vb === undefined ? va : blendValue(String(va), String(vb), t);
    }
    const { ground, least_contrast: least } = settings.keep_readable;
    const [groundA, groundB, groundNow] = [
        colourOf(a[ground]),
        colourOf(b[ground]),
        colourOf(out[ground])
    ];
    if (!groundA || !groundB || !groundNow) return out;
    for (const key of Object.keys(out)){
        if (key === ground) continue;
        const [ca, cb, now] = [
            colourOf(a[key]),
            colourOf(b[key]),
            colourOf(out[key])
        ];
        if (!ca || !cb || !now) continue;
        if (contrast(over(ca, groundA), groundA) < least || contrast(over(cb, groundB), groundB) < least) continue;
        if (contrast(over(now, groundNow), groundNow) >= least) continue;
        out[key] = contrast(over(ca, groundNow), groundNow) >= contrast(over(cb, groundNow), groundNow) ? a[key] : b[key];
    }
    return out;
}
