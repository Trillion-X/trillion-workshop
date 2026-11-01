// parts/screen-look/read-data/device-look-tokens.js
//
// PURPOSE
//   A resolved look (the CSS variable to value palette resolveScreenLookPalette writes) split into what a device that
//   cannot run CSS carries: its plain colours as [red, green, blue, opacity] channels (each 0-1), its lengths in points,
//   its faces by role (each `--font-<role>` family list, first first) and its primary button. One owner for two roads:
//   the build compiles it into each device's first-launch palette, and an account's look reader hands the same shape to
//   every native surface at run time.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No value is decided here: every colour, length and face comes from the palette handed in.
//   2. Dependency-free and pure, so the Worker, node scripts and tests all run it.
//   3. A colour this cannot read is not a colour (it is left out of `colors`); the build road refuses it (`channels`).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** A colour's red, green, blue (0-255) and opacity, or null when the value is not a plain colour (#rgb, #rrggbb,
 *  #rrggbbaa, rgb() or rgba()). */
export function channelsOrNull(color) {
  const text = String(color).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (hex) {
    const full = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1];
    const at = i => Number.parseInt(full.slice(i, i + 2), 16);
    return [at(0), at(2), at(4), full.length === 8 ? at(6) / 255 : 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  return null;
}

/** channelsOrNull, refusing a value that is not a plain colour. */
export function channels(color) {
  const parsed = channelsOrNull(color);
  if (!parsed) throw new Error(`a look colour must be #rrggbb or rgba(), not ${color}`);
  return parsed;
}

const unit = value => Number(value.toFixed(4));
/** A colour as the 0-1 [red, green, blue, opacity] a device draws with. */
export const unitChannels = color => {
  const [red, green, blue, opacity] = channels(color);
  return [unit(red / 255), unit(green / 255), unit(blue / 255), unit(opacity)];
};

/** A CSS font-family list as its families in order, unquoted: 'Recoleta, system-ui, "Segoe UI"' -> [Recoleta, system-ui, Segoe UI]. */
export const fontFamilies = value => String(value).split(',').map(family => family.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean);

/** A resolved palette's plain colours (as written), lengths in points and faces by role. */
export function paletteTokens(palette) {
  const colors = {};
  const lengths = {};
  const faces = {};
  for (const [variable, value] of Object.entries(palette)) {
    const name = variable.replace(/^--/, '');
    const face = /^--font-(?!size-)(.+)$/.exec(variable);
    if (face) faces[face[1]] = fontFamilies(value);
    else if (channelsOrNull(value)) colors[name] = String(value).trim();
    else if (/^-?\d+(\.\d+)?px$/.test(String(value).trim())) lengths[name] = Number.parseFloat(value);
  }
  return { colors, lengths, faces };
}

const line = value => ({ offset_y: value.offset_y, blur: value.blur, color: unitChannels(value.color) });

/** A look as a device carries it at run time: `look_id`, `name`, `colors` (name to 0-1 channels), `lengths`, `faces`
 *  and `button` (resolveScreenLookButton's shape with its colours as channels). */
export function deviceLook({ id, name }, palette, button) {
  const { colors, lengths, faces } = paletteTokens(palette);
  return {
    look_id: id,
    name,
    colors: Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, unitChannels(value)])),
    lengths,
    faces,
    button: {
      radius: button.radius,
      fill: unitChannels(button.fill),
      fill_pressed: unitChannels(button.fill_pressed),
      text: unitChannels(button.text),
      sheen_top: unitChannels(button.sheen.top),
      sheen_bottom: unitChannels(button.sheen.bottom),
      border: unitChannels(button.border),
      highlight: line(button.highlight),
      contact: line(button.contact),
      shadow: line(button.shadow),
      pressed_highlight: line(button.pressed_highlight),
      pressed_scale: button.pressed_scale,
    },
  };
}
