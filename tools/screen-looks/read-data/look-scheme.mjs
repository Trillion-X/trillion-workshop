// tools/screen-looks/read-data/look-scheme.mjs
//
// PURPOSE
//   Whether a look is light or dark, read from the look's own ground colour, and the colour arithmetic that question
//   needs (parse a colour, its brightness, the contrast between two). Kept apart from look-over-time.mjs so a page
//   that only needs its scheme (a public share page's script) does not carry schedule logic with it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no page, no records, no clock. The caller hands in the resolved variables and names the ground role.
//   2. Blind: nothing here names a look or a colour; the ground role is a parameter from the caller's settings or the
//      look's background role on a share page.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export function parseColour(text) {
    if (text.startsWith('#')) {
        const hex = text.slice(1);
        const full = hex.length <= 4 ? [
            ...hex
        ].map((c)=>c + c).join('') : hex;
        if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return null;
        const n = (i)=>parseInt(full.slice(i, i + 2), 16);
        return [
            n(0),
            n(2),
            n(4),
            full.length === 8 ? n(6) / 255 : 1
        ];
    }
    const parts = text.replace(/^rgba?\(|\)$/g, '').split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n)=>!Number.isFinite(n))) return null;
    return [
        parts[0],
        parts[1],
        parts[2],
        Number.isFinite(parts[3]) ? parts[3] : 1
    ];
}
export const toLinear = (c)=>{
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b])=>0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
export const contrast = (a, b)=>{
    const [x, y] = [
        luminance(a),
        luminance(b)
    ].sort((m, n)=>n - m);
    return (x + 0.05) / (y + 0.05);
};
export const colourOf = (value)=>value !== undefined && /^\s*(#|rgb)/i.test(value) ? parseColour(value.trim()) : null;
/** Whether a look is light or dark, from its own ground colour: dark when white words read better on it than black ones.
 *  Null when the ground is not a plain colour. The app and a public share page both ask this one question. */
export function screenLookScheme(resolvedVariables, groundRole) {
    const ground = colourOf(resolvedVariables[groundRole]);
    if (!ground) return null;
    return contrast(ground, [
        255,
        255,
        255,
        1
    ]) > contrast(ground, [
        0,
        0,
        0,
        1
    ]) ? 'dark' : 'light';
}
