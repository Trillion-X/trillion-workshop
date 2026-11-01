// tools/screen-looks/read-data/resolve-screen-look-palette.js
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The CROSS-PLATFORM theme single-source-of-truth resolver. Given a screen-look
// theme's tokens, it returns the concrete `{ name -> value }` palette map. This
// is the SAME math the browser applies as CSS variables — authored ONCE here, in
// dependency-free JavaScript, so EVERY platform consumes one resolver:
//   - Browser: ApplyCurrentScreenLook.tsx imports resolveScreenLookPalette and
//     writes the map onto document.documentElement as CSS variables.
//   - iOS/JavaScriptCore: a show-ios-jscore mount loads this file and reads the
//     concrete map to put real hex/rgba values into render atoms — because the
//     blind shell only paints concrete colors, never theme tokens.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO dependencies, ZERO DOM, ZERO platform assumptions. Pure data in/out.
// 2. This is the ONLY place the token-to-palette math lives. The browser TS side
//    consumes THIS file (L088 — one source across the language boundary). Do not
//    re-implement this math in TypeScript or in any consuming package.
// 3. Output values are CONCRETE (hex like `#111827` or `rgba(r, g, b, a)`), never
//    token names. The shell is blind to token meaning; the package supplies
//    concrete colors resolved here.
// =============================================================================

'use strict';

  var SANS_FONT_FALLBACK =
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  var MONO_FONT_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  var GENERIC_FONT_FAMILY_PATTERN =
    /(^|,)\s*(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|emoji|math|fangsong)(\s*,|$)/i;

  function tokensOf(theme) {
    return theme && Array.isArray(theme.tokens) ? theme.tokens : [];
  }

  function tokenValueByKey(theme, key) {
    var tokens = tokensOf(theme);
    for (var i = 0; i < tokens.length; i += 1) {
      if (tokens[i] && tokens[i].key === key) {
        var value = tokens[i].value;
        return value == null || value === '' ? null : String(value);
      }
    }
    return null;
  }

  function tokenValueByCssVariable(theme, cssVariable) {
    var tokens = tokensOf(theme);
    for (var i = 0; i < tokens.length; i += 1) {
      if (tokens[i] && tokens[i].css_variable === cssVariable) {
        var value = tokens[i].value;
        return value == null || value === '' ? null : String(value);
      }
    }
    return null;
  }

  function tokenValue(theme, key, fallback) {
    var value = tokenValueByKey(theme, key);
    return value == null ? fallback : value;
  }

  function firstTokenValue(theme, compactKey, cssVariables, fallback) {
    var compactValue = tokenValueByKey(theme, compactKey);
    if (compactValue) return compactValue;
    for (var i = 0; i < cssVariables.length; i += 1) {
      var cssValue = tokenValueByCssVariable(theme, cssVariables[i]);
      if (cssValue) return cssValue;
    }
    return fallback;
  }

  function numberTokenValue(theme, key, fallback) {
    var tokens = tokensOf(theme);
    for (var i = 0; i < tokens.length; i += 1) {
      if (tokens[i] && tokens[i].key === key) {
        var raw = tokens[i].value;
        if (typeof raw === 'number' && isFinite(raw)) return raw;
        if (typeof raw === 'string' && raw.trim()) {
          var parsed = Number(raw);
          if (isFinite(parsed)) return parsed;
        }
      }
    }
    return fallback;
  }

  function remFromPixels(value) {
    return (value / 16) + 'rem';
  }

  function resolveScreenLookTypography(theme) {
    return {
      display: numberTokenValue(theme, 'fontSizeDisplay', 48),
      heading2xl: numberTokenValue(theme, 'fontSizeHeading2xl', 30),
      headingXl: numberTokenValue(theme, 'fontSizeHeadingXl', 24),
      headingLg: numberTokenValue(theme, 'fontSizeHeadingLg', 18),
      heading: numberTokenValue(theme, 'fontSizeHeading', 14),
      headingXs: numberTokenValue(theme, 'fontSizeHeadingXs', 12),
      bodyLg: numberTokenValue(theme, 'fontSizeBodyLg', 18),
      body: numberTokenValue(theme, 'fontSizeBody', 14),
      bodyXs: numberTokenValue(theme, 'fontSizeBodyXs', 12),
      label: numberTokenValue(theme, 'fontSizeLabel', 12),
      caption: numberTokenValue(theme, 'fontSizeCaption', 12),
      micro: numberTokenValue(theme, 'fontSizeMicro', 10),
    };
  }

  function screenLookFontFamily(value) {
    var font = String(value || '').trim();
    if (!font) return SANS_FONT_FALLBACK;
    if (GENERIC_FONT_FAMILY_PATTERN.test(font)) return font;
    return font + ', ' + SANS_FONT_FALLBACK;
  }

  function parseHexColor(value) {
    var normalized = String(value || '').trim();
    var short = /^#([0-9a-f]{3})$/i.exec(normalized);
    if (short) {
      var parts = short[1].split('');
      return {
        r: parseInt(parts[0] + parts[0], 16),
        g: parseInt(parts[1] + parts[1], 16),
        b: parseInt(parts[2] + parts[2], 16),
      };
    }
    var long = /^#([0-9a-f]{6})$/i.exec(normalized);
    if (!long) return null;
    var raw = long[1];
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16),
    };
  }

  function rgba(color, alpha) {
    var rgb = parseHexColor(color);
    if (!rgb) return color;
    return 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + alpha + ')';
  }

  // A plain colour (#rgb, #rrggbb, rgb() or rgba()) as { r, g, b, a }, or null.
  function colourChannels(value) {
    var hex = parseHexColor(value);
    if (hex) return Object.assign({ a: 1 }, hex);
    var rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(String(value || ''));
    if (!rgb) return null;
    var parsed = { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] == null ? 1 : Number(rgb[4]) };
    return parsed.r <= 255 && parsed.g <= 255 && parsed.b <= 255 && parsed.a <= 1 ? parsed : null;
  }

  // A colour at `alpha` of its own opacity, for any plain colour (rgba() above reads only #hex).
  function withAlpha(color, alpha, fallback) {
    var parsed = colourChannels(color);
    if (!parsed) return fallback;
    return 'rgba(' + parsed.r + ', ' + parsed.g + ', ' + parsed.b + ', ' + Math.round(parsed.a * alpha * 1000) / 1000 + ')';
  }

  // `from` moved `amount` (0-1) of the way to `to`, as #rrggbb; null when either is not an opaque plain colour.
  function mixColours(from, to, amount) {
    var a = colourChannels(from);
    var b = colourChannels(to);
    if (!a || !b || a.a !== 1 || b.a !== 1) return null;
    var hex = function (value) { var text = Math.round(value).toString(16); return text.length === 1 ? '0' + text : text; };
    return '#' + ['r', 'g', 'b'].map(function (key) { return hex(a[key] + (b[key] - a[key]) * amount); }).join('');
  }

  // WCAG relative luminance of a plain colour, or null.
  function luminanceOf(color) {
    var rgb = colourChannels(color);
    if (!rgb) return null;
    function channel(value) {
      var normalized = value / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  // A tinted badge's ground and words are separate colour roles. Realize them here, before Tailwind can
  // replace an unsupported nested color-mix() with an opaque fallback that Dark Reader then recolours.
  // These keep the success tone's existing 65% ink mix and 15% tint; no consumer chooses a new green.
  function successBadgeColors(palette) {
    var channels = colourChannels;
    var tone = palette['--color-success'] || palette['--accent-primary'];
    var success = channels(tone);
    var words = channels(palette['--text-primary']);
    var color = 'color-mix(in srgb, ' + tone + ' 65%, ' + palette['--text-primary'] + ')';
    if (success && words) {
      var alpha = success.a * 0.65 + words.a * 0.35;
      var values = ['r', 'g', 'b'].map(function (key) {
        return alpha ? Math.round((success[key] * success.a * 0.65 + words[key] * words.a * 0.35) / alpha * 1000) / 1000 : 0;
      });
      if (!palette['--badge-success-text']) palette['--badge-success-text'] = alpha === 1 ? 'rgb(' + values.join(', ') + ')' : 'rgba(' + values.join(', ') + ', ' + alpha + ')';
      if (!palette['--badge-success-bg']) palette['--badge-success-bg'] = 'rgba(' + values.join(', ') + ', ' + (alpha * 0.15) + ')';
    } else {
      if (!palette['--badge-success-text']) palette['--badge-success-text'] = color;
      if (!palette['--badge-success-bg']) palette['--badge-success-bg'] = 'color-mix(in srgb, ' + color + ' 15%, transparent)';
    }
    return palette;
  }

  function applyAuthoredCssVariables(theme, palette) {
    var tokens = tokensOf(theme);
    var applied = {};
    for (var i = 0; i < tokens.length; i += 1) {
      var token = tokens[i];
      if (!token) continue;
      var cssVariable =
        token.css_variable ||
        (typeof token.key === 'string' && token.key.indexOf('--') === 0
          ? token.key
          : null);
      // Raw CSS-variable tokens carry already-realized CSS strings. Numeric
      // design inputs (font sizes, radius bases) must keep flowing through the
      // role resolver so units and derived ladders remain correct.
      if (
        cssVariable &&
        !applied[cssVariable] &&
        typeof token.value === 'string' &&
        token.value !== ''
      ) {
        // A face named raw still gets the sans fallback, so a look whose face is not loaded never falls to the browser's serif.
        palette[cssVariable] = /^--font-(primary|display|heading|body)$/.test(cssVariable) ? screenLookFontFamily(token.value) : token.value;
        applied[cssVariable] = true;
      }
    }
    return palette;
  }

  function readableTextFor(background, minimumContrast) {
    if (!parseHexColor(background)) return '#000000';
    var luminance = luminanceOf(background);
    var white = 1.05 / (luminance + 0.05);
    var black = (luminance + 0.05) / 0.05;
    // The strong button's semibold label keeps the look's established 3:1 rule. A smaller work result such as "Done"
    // asks for 4.5:1, so choose the higher-contrast neutral words instead of treating a bright status fill as bold text.
    if (minimumContrast && minimumContrast > 3) return white >= black ? '#ffffff' : '#000000';
    return white >= 3 ? '#ffffff' : '#000000';
  }

  // Role radius ladder (L069): ONE theme base drives every role. Surfaces take
  // the full radius; controls a tighter 0.75x; chips/labels a compact 0.375x.
  // This is the ONLY place the ladder math lives (L088) — browser TS consumes it.
  function radiusRolePixels(radiusBase) {
    return {
      card: radiusBase,
      control: Math.round(radiusBase * 0.75),
      chip: Math.round(radiusBase * 0.375),
      check: Math.round(radiusBase * 0.25),
    };
  }

  // Nested corners. A rounded thing sitting `gap` in from a rounded holder's edge takes the holder's corner less the
  // gap, never below zero, so the two curves run parallel; a holder whose corner follows what it holds takes the held
  // corner plus the gap. parts/screen-look/show/nested-corners.css is the same rule as CSS variables (--corner-in,
  // --corner-out), scripts/make-device-looks.mjs writes it into every compiled device palette, and
  // scripts/check-narrow-widths.mjs measures every screen against it (corners-not-concentric).
  function nestedCorner(outer, gap) {
    return Math.max(0, outer - gap);
  }

  function holdingCorner(held, gap) {
    return held + gap;
  }

  // Spacing rhythm: every gap is a whole number of one base step (the look's `spacingBase`, 4px when it names none),
  // so a look that changes the step changes every gap in proportion. The steps written are the ones parts use.
  var SPACE_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16];

  // Density. One attribute of a look (the `density` token: compact, standard or comfortable) is one multiplier, and every
  // pad, gap, control height and icon is its base times that multiplier, so a component never branches on density
  // (Claude's design system re-declares one scale for its comfortable mode). The steps are DATA here; a look that names
  // an unknown density is standard.
  var DENSITY = { compact: 0.875, standard: 1, comfortable: 1.125 };
  var CONTROL_HEIGHTS = { sm: 28, md: 32, lg: 40 };
  var ICON_SIZES = { sm: 14, md: 16, lg: 20 };

  function densityScale(theme) {
    var named = String(tokenValue(theme, 'density', 'standard')).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(DENSITY, named) ? DENSITY[named] : 1;
  }

  function resolveScreenLookDensity(scale) {
    var variables = { '--density-scale': String(scale) };
    for (var size in CONTROL_HEIGHTS) variables['--control-height-' + size] = Math.round(CONTROL_HEIGHTS[size] * scale) + 'px';
    for (var icon in ICON_SIZES) variables['--icon-size-' + icon] = Math.round(ICON_SIZES[icon] * scale) + 'px';
    return variables;
  }

  function resolveScreenLookSpacing(theme) {
    var base = numberTokenValue(theme, 'spacingBase', 4) * densityScale(theme);
    var steps = {};
    for (var index = 0; index < SPACE_STEPS.length; index += 1) steps[SPACE_STEPS[index]] = base * SPACE_STEPS[index];
    return { base: base, steps: steps };
  }

  // Radius ladder. A fixed ladder of corner steps (ChatGPT's 0.125 to 1.5rem bases, drawn at the 16px reference) times ONE
  // editable corner scale, which is the look's corner radius over that reference, so the person's single Radius control
  // still moves every step. The role radii above (card, control, chip) stay, and nested corners are derived from
  // whichever step holds them (nested-corners.css), never typed.
  var RADIUS_REFERENCE = 16;
  var RADIUS_LADDER = { xs: 2, sm: 4, md: 6, lg: 8, xl: 10, '2xl': 12, '3xl': 16, '4xl': 20, '5xl': 24 };

  function resolveScreenLookRadiusLadder(radiusBase) {
    var scale = radiusBase / RADIUS_REFERENCE;
    var variables = { '--corner-radius-scale': String(Math.round(scale * 1000) / 1000) };
    for (var step in RADIUS_LADDER) variables['--radius-' + step] = Math.round(RADIUS_LADDER[step] * scale) + 'px';
    return variables;
  }

  function resolveScreenLookRadiusRoles(radiusBase) {
    var pixels = radiusRolePixels(radiusBase);
    return {
      card: pixels.card + 'px',
      control: pixels.control + 'px',
      chip: pixels.chip + 'px',
      check: pixels.check + 'px',
    };
  }

  // Depth. A look is dark when white words read better on its ground than black ones (the same test as
  // look-scheme.mjs). Things stand off the ground in three surface steps and four elevations:
  //   - on a dark ground a shadow cannot show (black on black), so each step is the ground moved toward the ink, and
  //     every elevation carries a lit top edge (a 1px inside line of the ink) above its drop (Linear's dark recipe);
  //   - on a light ground the steps run from the look's surface to white, and each elevation is two soft drops tinted
  //     with the look's shadow tint (`shadowTintColor` / --shadow-tint; the ink when it names none), so a warm paper
  //     look casts warm shadows, never grey ones (Notion's warm two-layer recipe).
  // Elevation 1 is a card at rest, 2 a menu or hover card, 3 a popover or dialog, 4 a modal over the whole page. Every
  // floating thing here already draws its own 1px border, so no elevation adds a second outline.
  var SURFACE_STEPS = { dark: [0.05, 0.08, 0.11], light: [0, 0.6, 1] };
  var ELEVATION = {
    dark: [
      { edge: 0.06, drops: [[0, 1, 2, 0, 0.4]] },
      { edge: 0.08, drops: [[0, 4, 16, 0, 0.5]] },
      { edge: 0.08, drops: [[0, 8, 32, 0, 0.6]] },
      { edge: 0.1, drops: [[0, 24, 64, 0, 0.7]] },
    ],
    light: [
      { drops: [[0, 1, 2, 0, 0.05], [0, 4, 12, -2, 0.05]] },
      { drops: [[0, 2, 6, 0, 0.05], [0, 8, 16, -4, 0.07]] },
      { drops: [[0, 8, 32, 0, 0.07], [0, 24, 72, -24, 0.18]] },
      { drops: [[0, 16, 48, 0, 0.1], [0, 40, 100, -20, 0.28]] },
    ],
  };

  function isDarkGround(background) {
    var luminance = luminanceOf(background);
    return luminance != null && 1.05 / (luminance + 0.05) > (luminance + 0.05) / 0.05;
  }

  function resolveScreenLookDepth(background, foreground, surface, shadowTint) {
    var dark = isDarkGround(background);
    var steps = SURFACE_STEPS[dark ? 'dark' : 'light'];
    var variables = {};
    for (var index = 0; index < steps.length; index += 1) {
      variables['--surface-' + (index + 1)] = dark
        ? mixColours(background, foreground, steps[index]) || surface
        : mixColours(surface, '#ffffff', steps[index]) || surface;
    }
    variables['--surface-edge'] = withAlpha(foreground, 0.08, 'rgba(127, 127, 127, 0.16)');
    var levels = ELEVATION[dark ? 'dark' : 'light'];
    var tint = dark ? '#000000' : shadowTint;
    // Every look names its tint, so two looks always carry the same roles (a blend between them keeps every role).
    variables['--shadow-tint'] = tint;
    for (var level = 0; level < levels.length; level += 1) {
      var row = levels[level];
      var layers = row.edge ? ['inset 0 1px 0 0 ' + withAlpha(foreground, row.edge, 'rgba(255, 255, 255, ' + row.edge + ')')] : [];
      for (var drop = 0; drop < row.drops.length; drop += 1) {
        var d = row.drops[drop];
        layers.push(d[0] + ' ' + d[1] + 'px ' + d[2] + 'px ' + d[3] + 'px ' + withAlpha(tint, d[4], 'rgba(0, 0, 0, ' + d[4] + ')'));
      }
      variables['--elevation-' + (level + 1)] = layers.join(', ');
    }
    variables['--surface-shadow'] = variables['--elevation-1'];
    variables['--surface-shadow-raised'] = variables['--elevation-3'];
    return variables;
  }

  // Type roles. Each role is one size the look chooses (its font-size tokens, editable) carried with the line height,
  // tracking and weight that size reads best at, so every consumer that names a role gets all four together instead of
  // a bare size (Linear's and ChatGPT's role tokens; tracking tightens as size grows, as SF and Inter want). Written as
  // --type-<role>-size, -leading (unitless), -tracking (em) and -weight.
  var TYPE_ROLES = [
    { role: 'display', size: 'display', leading: 1.08, tracking: -0.022, weight: 600 },
    { role: 'title-1', size: 'heading2xl', leading: 1.2, tracking: -0.02, weight: 600 },
    { role: 'title-2', size: 'headingXl', leading: 1.25, tracking: -0.017, weight: 600 },
    { role: 'title-3', size: 'headingLg', leading: 1.35, tracking: -0.012, weight: 600 },
    { role: 'heading', size: 'heading', leading: 1.43, tracking: -0.006, weight: 600 },
    { role: 'heading-xs', size: 'headingXs', leading: 1.34, tracking: 0, weight: 600 },
    { role: 'body-lg', size: 'bodyLg', leading: 1.55, tracking: -0.011, weight: 400 },
    { role: 'body', size: 'body', leading: 1.43, tracking: -0.006, weight: 400 },
    { role: 'body-xs', size: 'bodyXs', leading: 1.34, tracking: 0, weight: 400 },
    { role: 'label', size: 'label', leading: 1.34, tracking: 0, weight: 500 },
    { role: 'caption', size: 'caption', leading: 1.34, tracking: 0, weight: 400 },
    { role: 'micro', size: 'micro', leading: 1.4, tracking: 0.01, weight: 500 },
  ];

  function resolveScreenLookTypeRoles(typography) {
    var variables = {};
    for (var index = 0; index < TYPE_ROLES.length; index += 1) {
      var row = TYPE_ROLES[index];
      var prefix = '--type-' + row.role;
      variables[prefix + '-size'] = remFromPixels(typography[row.size]);
      variables[prefix + '-leading'] = String(row.leading);
      variables[prefix + '-tracking'] = row.tracking + 'em';
      variables[prefix + '-weight'] = String(row.weight);
    }
    return variables;
  }

  // Focus. One ring for every focused control in every look, drawn in three layers (Claude's focus shadow): a gap of
  // the page's own colour, the ring in the look's ink, and a soft glow of its accent. It is never the accent itself,
  // which vanished on the look's accent-filled strong button; a danger ring is the same in the look's error colour.
  var FOCUS_RING = { width: 2, offset: 2, ink: 0.9, glow: 0.22, glow_blur: 8 };

  function focusRingShadow(page, ring, glow) {
    var outer = FOCUS_RING.offset + FOCUS_RING.width;
    return '0 0 0 ' + FOCUS_RING.offset + 'px ' + page + ', 0 0 0 ' + outer + 'px ' + ring + ', 0 0 ' + FOCUS_RING.glow_blur + 'px ' + outer + 'px ' + glow;
  }

  function resolveScreenLookFocus(background, foreground, primary, danger) {
    var ring = withAlpha(foreground, FOCUS_RING.ink, foreground);
    var dangerRing = withAlpha(danger, FOCUS_RING.ink, danger);
    return {
      '--focus-ring-color': ring,
      '--focus-ring-width': FOCUS_RING.width + 'px',
      '--focus-ring-offset': FOCUS_RING.offset + 'px',
      '--focus-ring-glow': withAlpha(primary, FOCUS_RING.glow, 'transparent'),
      '--focus-ring': focusRingShadow(background, ring, withAlpha(primary, FOCUS_RING.glow, 'transparent')),
      '--focus-ring-danger-color': dangerRing,
      '--focus-ring-danger': focusRingShadow(background, dangerRing, withAlpha(danger, FOCUS_RING.glow, 'transparent')),
      '--border-focus': ring,
      '--high-contrast-border-focus': withAlpha(foreground, 1, foreground),
    };
  }

  // Motion. Five durations and the curves things move on (Claude's 60-450ms ladder; ChatGPT's enter, exit and move
  // curves; a snap and an overshoot), the same numbers the browser reads as CSS variables and parts/ui/motion reads as
  // JavaScript. Every CSS duration is multiplied by --motion-scale, which screen-look/show/surfaces.css sets to almost
  // nothing when the person asks for reduced motion (never 0: a 0s transition fires no transitionend, which would leave
  // a part waiting). The spring is a damped spring sampled into a linear() curve over its own settle time.
  var MOTION = {
    durations: { instant: 60, fast: 120, base: 200, sheet: 300, slow: 450 },
    curves: {
      enter: [0.19, 1, 0.22, 1],
      exit: [0.8, 0, 0.4, 1],
      move: [0.65, 0, 0.35, 1],
      snap: [0.32, 0.72, 0, 1],
      overshoot: [0.34, 1.3, 0.64, 1],
    },
    spring: { stiffness: 400, damping: 28, mass: 1, samples: 24 },
  };

  var PLACEHOLDER = { reveal_delay: 300, breathe: 1600, breathe_low: 0.6, shimmer: 1900 };

  // A damped spring from 0 to 1 sampled until it settles: its settle time in ms and its linear() curve.
  function springCurve(spring) {
    var omega = Math.sqrt(spring.stiffness / spring.mass);
    var zeta = spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass));
    var position = function (time) {
      if (zeta < 1) {
        var damped = omega * Math.sqrt(1 - zeta * zeta);
        return 1 - Math.exp(-zeta * omega * time) * (Math.cos(damped * time) + (zeta * omega / damped) * Math.sin(damped * time));
      }
      return 1 - Math.exp(-omega * time) * (1 + omega * time);
    };
    var settle = 0.01;
    while (settle < 3 && Math.abs(1 - position(settle)) > 0.001) settle += 0.01;
    var points = [];
    for (var index = 0; index <= spring.samples; index += 1) points.push(Math.round(position(settle * index / spring.samples) * 1000) / 1000);
    points[points.length - 1] = 1;
    return { duration: Math.round(settle * 1000), curve: 'linear(' + points.join(', ') + ')' };
  }

  // Ink. Every quieter word, line and fill of a look is its one ink (the text colour) at one of nine opacities, so the
  // steps are evenly apart and no two roles sit a hair from each other (they were hand-set per look: secondary 0.72
  // beside tertiary 0.66, 449 one-off mixes in parts). Written as --ink and --ink-1 to --ink-9, and the look's roles
  // read their step here (Claude's alpha ladder over one neutral; Notion's one warm grey).
  var INK_STEPS = [0.03, 0.05, 0.08, 0.1, 0.16, 0.32, 0.54, 0.72, 0.92];
  var INK_ROLES = {
    '--glass-bg-secondary': 1, '--glass-bg-subtle': 1, '--glass-bg-hover': 2, '--glass-bg-active': 3,
    '--border-primary': 4, '--border-secondary': 5, '--text-dim': 5, '--text-ghost': 6,
    '--text-muted': 7, '--text-subtle': 7, '--text-tertiary': 8, '--text-secondary': 8, '--text-strong': 9,
  };

  function resolveScreenLookInk(foreground) {
    var variables = { '--ink': foreground };
    for (var index = 0; index < INK_STEPS.length; index += 1) variables['--ink-' + (index + 1)] = withAlpha(foreground, INK_STEPS[index], foreground);
    for (var role in INK_ROLES) variables[role] = variables['--ink-' + INK_ROLES[role]];
    return variables;
  }

  // Glass. A floating surface blurs and deepens what lies under it by one amount in every look (Linear's header).
  var GLASS = { blur: 20, saturate: 1.8 };

  function resolveScreenLookGlass() {
    return {
      '--glass-blur': GLASS.blur + 'px',
      '--glass-saturate': String(GLASS.saturate),
      '--glass-backdrop': 'blur(' + GLASS.blur + 'px) saturate(' + GLASS.saturate + ')',
    };
  }

  function resolveScreenLookMotion() {
    var variables = {};
    var scaled = function (ms) { return 'calc(' + ms + 'ms * var(--motion-scale, 1))'; };
    for (var name in MOTION.durations) variables['--motion-' + name] = scaled(MOTION.durations[name]);
    for (var curve in MOTION.curves) variables['--ease-' + curve] = 'cubic-bezier(' + MOTION.curves[curve].join(', ') + ')';
    var spring = springCurve(MOTION.spring);
    variables['--ease-spring'] = spring.curve;
    variables['--motion-spring'] = scaled(spring.duration);
    // Placeholders that wait: a loading block shows only after the reveal delay, so a fast answer never flashes one, then
    // breathes and shimmers at these paces (0.3s here, tuned by its maker; ChatGPT's recovered value is 0.5s; Claude's skeleton breathe and text shimmer).
    // The delay is a wait, not motion, so it does not shrink with --motion-scale.
    variables['--placeholder-reveal-delay'] = PLACEHOLDER.reveal_delay + 'ms';
    variables['--placeholder-breathe-duration'] = scaled(PLACEHOLDER.breathe);
    variables['--placeholder-breathe-low'] = String(PLACEHOLDER.breathe_low);
    variables['--shimmer-duration'] = scaled(PLACEHOLDER.shimmer);
    return variables;
  }

  // The button's face, crafted the way a pressed-metal key is: a sheen that runs light at the top of the fill
  // to slightly deeper at the bottom, a 1px edge a shade darker than the fill, a light line along the top inside edge,
  // and two shadows under it at rest (a tight contact line and a soft drop). While pressed, a darker top line and a
  // slight shrink. Every colour here is translucent, so it lies over whatever fill the button wears (the look's primary,
  // the danger red, a press's done green) and reads as that fill's own shading. Its corner is the look's control radius
  // and its fill the look's primary button colour, so a look's change reaches every button. This is the ONLY place a
  // button's look is decided: the web reads it as the CSS variables resolveScreenLookPalette writes, and
  // scripts/make-device-looks.mjs carries the same values into the Chrome extension's stylesheet and the iPhone, Watch
  // and Mac apps' ios/Shared/ButtonLook.swift.
  var BUTTON_DEPTH = {
    sheen: { top: 'rgba(255, 255, 255, 0.16)', bottom: 'rgba(0, 0, 0, 0.1)' },
    edge: 'rgba(0, 0, 0, 0.22)',
    highlight: { offset_y: 2, blur: 0, color: 'rgba(255, 255, 255, 0.3)' },
    contact: { offset_y: 1, blur: 1, color: 'rgba(25, 25, 25, 0.16)' },
    shadow: { offset_y: 3, blur: 8, color: 'rgba(25, 25, 25, 0.14)' },
    pressed_highlight: { offset_y: 2, blur: 0, color: 'rgba(0, 0, 0, 0.12)' },
    pressed_scale: 0.98,
  };

  // A theme's primary button as plain values: every colour concrete, every length in pixels.
  function resolveScreenLookButton(theme) {
    var palette = resolveScreenLookPalette(theme);
    return {
      radius: radiusRolePixels(numberTokenValue(theme, 'defaultBorderRadius', 16)).control,
      fill: palette['--button-primary-bg'],
      fill_pressed: palette['--button-primary-bg-hover'],
      text: palette['--button-primary-text'],
      sheen: BUTTON_DEPTH.sheen,
      border: BUTTON_DEPTH.edge,
      highlight: BUTTON_DEPTH.highlight,
      contact: BUTTON_DEPTH.contact,
      shadow: BUTTON_DEPTH.shadow,
      pressed_highlight: BUTTON_DEPTH.pressed_highlight,
      pressed_scale: BUTTON_DEPTH.pressed_scale,
    };
  }

  function lineShadow(line, inset) {
    return (inset ? 'inset ' : '') + '0 ' + line.offset_y + 'px ' + line.blur + 'px ' + line.color;
  }

  // The face as the CSS variables a button reads: --button-sheen (a background-image over its fill), --button-highlight
  // (the inside lines: the darker 1px edge on top of the light line just inside it, both drawn inside so a button never
  // grows by a border),
  // --button-shadow (the contact line and the soft drop), --button-pressed-highlight and --button-pressed-scale.
  function buttonDepthCssVariables() {
    return {
      '--button-sheen': 'linear-gradient(180deg, ' + BUTTON_DEPTH.sheen.top + ', ' + BUTTON_DEPTH.sheen.bottom + ')',
      '--button-highlight': 'inset 0 0 0 1px ' + BUTTON_DEPTH.edge + ', ' + lineShadow(BUTTON_DEPTH.highlight, true),
      '--button-shadow': lineShadow(BUTTON_DEPTH.contact, false) + ', ' + lineShadow(BUTTON_DEPTH.shadow, false),
      '--button-pressed-highlight': 'inset 0 0 0 1px ' + BUTTON_DEPTH.edge + ', ' + lineShadow(BUTTON_DEPTH.pressed_highlight, true),
      '--button-pressed-scale': String(BUTTON_DEPTH.pressed_scale),
    };
  }

  // The one resolver. theme.tokens (Society data) -> concrete palette map.
  function resolveScreenLookPalette(theme) {
    var background = firstTokenValue(
      theme,
      'backgroundColor',
      ['--bg-primary', '--black-pure', '--surface-base'],
      '#111827'
    );
    var foreground = firstTokenValue(
      theme,
      'foregroundColor',
      ['--text-primary'],
      '#f8fafc'
    );
    var primary = firstTokenValue(
      theme,
      'primaryColor',
      ['--accent-primary', '--button-primary-bg', '--accent-blue', '--accent-cyan'],
      '#38bdf8'
    );
    var surface = firstTokenValue(
      theme,
      'surfaceColor',
      ['--bg-surface', '--black-rich', '--surface-base'],
      '#1f2937'
    );
    var radiusBase = numberTokenValue(theme, 'defaultBorderRadius', 16);
    var radiusRoles = resolveScreenLookRadiusRoles(radiusBase);
    var radius = radiusRoles.card;
    var radiusControl = radiusRoles.control;
    var radiusChip = radiusRoles.chip;
    // A check's corner is the look's own: a quarter of its Radius unless the look names `checkBorderRadius` (pixels; 9 or more
    // on the 18px check is a circle).
    var radiusCheck = numberTokenValue(theme, 'checkBorderRadius', radiusRolePixels(radiusBase).check) + 'px';
    var font = screenLookFontFamily(
      tokenValue(theme, 'defaultPrimaryFontFamily', 'Instrument Sans')
    );
    var displayFont = screenLookFontFamily(
      tokenValue(theme, 'displayFontFamily', tokenValue(theme, 'defaultPrimaryFontFamily', 'Instrument Sans'))
    );
    var monoFont = String(tokenValue(theme, 'monoFontFamily', '') || '').trim() || MONO_FONT_FALLBACK;
    var typography = resolveScreenLookTypography(theme);
    var primaryText = readableTextFor(primary);
    var success = firstTokenValue(theme, 'successColor', ['--color-success'], '#16a34a');
    var buttonSuccessBackground = mixColours(success, foreground, 0.35) || success;
    var calendarAction = firstTokenValue(theme, 'calendarActionColor', ['--calendar-action-fill'], '#0ba8ff');
    var calendarToday = firstTokenValue(theme, 'calendarTodayColor', ['--calendar-today-fill'], '#ff2865');
    var buttonDepth = buttonDepthCssVariables();
    var spacing = resolveScreenLookSpacing(theme);
    var shadowTint = firstTokenValue(theme, 'shadowTintColor', ['--shadow-tint'], foreground);
    var danger = firstTokenValue(theme, 'errorColor', ['--color-error'], '#dc2626');
    var buttonErrorForeground = mixColours(danger, foreground, 0.1) || danger;
    var spaceVariables = { '--space-unit': spacing.base + 'px' };
    for (var step in spacing.steps) spaceVariables['--space-' + step] = spacing.steps[step] + 'px';

    return successBadgeColors(applyAuthoredCssVariables(theme, Object.assign(spaceVariables,
      resolveScreenLookDensity(densityScale(theme)),
      resolveScreenLookRadiusLadder(radiusBase),
      resolveScreenLookDepth(background, foreground, surface, shadowTint),
      resolveScreenLookTypeRoles(typography),
      resolveScreenLookFocus(background, foreground, primary, danger),
      resolveScreenLookMotion(),
      resolveScreenLookGlass(),
      resolveScreenLookInk(foreground), {
      '--black-pure': background,
      '--black-rich': surface,
      '--surface-base': background,
      '--bg-primary': background,
      '--bg-surface': surface,
      '--glass-bg-primary': rgba(surface, 0.88),
      '--glass-bg-tertiary': rgba(surface, 0.36),
      '--glass-bg-input': rgba(surface, 0.92),
      '--glass-bg-popover': rgba(surface, 0.96),
      '--glass-popover-background': rgba(surface, 0.96),
      '--glass-overlay-background': rgba(background, 0.72),
      '--high-contrast-border-primary': rgba(primary, 0.44),
      '--high-contrast-border-secondary': rgba(primary, 0.58),
      '--text-primary': foreground,
      '--high-contrast-text-secondary': rgba(foreground, 0.88),
      '--high-contrast-text-tertiary': rgba(foreground, 0.78),
      '--high-contrast-text-muted': rgba(foreground, 0.66),
      '--inverse-bg': foreground,
      '--inverse-surface': rgba(background, 0.06),
      '--inverse-text-primary': background,
      '--inverse-text-strong': rgba(background, 0.92),
      '--inverse-text-secondary': rgba(background, 0.72),
      '--inverse-text-tertiary': rgba(background, 0.58),
      '--inverse-text-muted': rgba(background, 0.46),
      '--inverse-border-primary': rgba(background, 0.24),
      '--inverse-border-secondary': rgba(background, 0.16),
      '--inverse-action-bg': background,
      '--inverse-action-text': foreground,
      '--inverse-action-bg-hover': rgba(background, 0.87),
      '--inverse-shadow-prominent': '0 38px 100px rgba(0, 0, 0, 0.48)',
      '--accent-primary': primary,
      '--accent-blue': primary,
      '--accent-cyan': primary,
      '--accent-purple': primary,
      '--accent-emerald': primary,
      '--accent-indigo': primary,
      '--calendar-action-fill': calendarAction,
      '--calendar-action-hover': rgba(calendarAction, 0.88),
      '--calendar-action-text': readableTextFor(calendarAction),
      '--calendar-today-fill': calendarToday,
      '--calendar-today-text': readableTextFor(calendarToday),
      '--button-primary-bg': primary,
      '--button-primary-text': primaryText,
      '--button-primary-bg-hover': rgba(primary, 0.88),
      '--button-work-success-background': buttonSuccessBackground,
      '--button-work-success-foreground': readableTextFor(buttonSuccessBackground, 4.5),
      '--button-work-error-foreground': buttonErrorForeground,
      '--color-info': primary,
      '--scrollbar-thumb': rgba(foreground, 0.18),
      '--scrollbar-thumb-hover': rgba(foreground, 0.3),
      '--chat-input-bg': rgba(surface, 0.92),
      '--chat-input-border': rgba(primary, 0.24),
      '--chat-composer-radius': radius,
      '--radius-default': radius,
      '--radius-card': radius,
      '--radius-control': radiusControl,
      '--radius-chip': radiusChip,
      '--radius-check': radiusCheck,
      '--radius-pill': '999px',
      '--button-sheen': buttonDepth['--button-sheen'],
      '--button-highlight': buttonDepth['--button-highlight'],
      '--button-shadow': buttonDepth['--button-shadow'],
      '--button-pressed-highlight': buttonDepth['--button-pressed-highlight'],
      '--button-pressed-scale': buttonDepth['--button-pressed-scale'],
      '--font-primary': font,
      '--font-display': displayFont,
      '--font-mono': monoFont,
      '--default-font-family': font,
      '--font-size-display': remFromPixels(typography.display),
      '--font-size-heading-2xl': remFromPixels(typography.heading2xl),
      '--font-size-heading-xl': remFromPixels(typography.headingXl),
      '--font-size-heading-lg': remFromPixels(typography.headingLg),
      '--font-size-heading': remFromPixels(typography.heading),
      '--font-size-heading-xs': remFromPixels(typography.headingXs),
      '--font-size-body-lg': remFromPixels(typography.bodyLg),
      '--font-size-body': remFromPixels(typography.body),
      '--font-size-body-xs': remFromPixels(typography.bodyXs),
      '--font-size-label': remFromPixels(typography.label),
      '--font-size-caption': remFromPixels(typography.caption),
      '--font-size-micro': remFromPixels(typography.micro),
    })));
  }

  // The SEMANTIC palette the iOS JSCore mounts paint with — the
  // screen-arrangement chrome AND the screen-look chooser cards. One place maps
  // css-var tokens to named slots so every iOS surface recolors identically from
  // the SAME theme (no per-mount duplication, no per-mount drift). A null/unknown
  // theme yields the default dark palette (all fallbacks).
  function resolveScreenLookNamedPalette(theme) {
    var map = resolveScreenLookPalette(theme) || {};
    function pick(variable, fallback) {
      var value = map[variable];
      return typeof value === 'string' && value ? value : fallback;
    }
    return {
      background: pick('--bg-primary', '#111827'),
      surface: pick('--bg-surface', '#1f2937'),
      headerBg: pick('--glass-bg-primary', 'rgba(31, 41, 55, 0.88)'),
      surfaceRaised: pick('--glass-bg-subtle', 'rgba(56, 189, 248, 0.08)'),
      glassHover: pick('--glass-bg-hover', 'rgba(56, 189, 248, 0.14)'),
      glassActive: pick('--glass-bg-active', 'rgba(56, 189, 248, 0.22)'),
      popoverBg: pick('--glass-bg-popover', 'rgba(31, 41, 55, 0.96)'),
      overlayBg: pick('--glass-overlay-background', 'rgba(17, 24, 39, 0.72)'),
      borderPrimary: pick('--border-primary', 'rgba(56, 189, 248, 0.24)'),
      borderSecondary: pick('--border-secondary', 'rgba(56, 189, 248, 0.36)'),
      borderFocus: pick('--border-focus', 'rgba(56, 189, 248, 0.58)'),
      textPrimary: pick('--text-primary', '#f8fafc'),
      textStrong: pick('--text-strong', 'rgba(248, 250, 252, 0.92)'),
      textSecondary: pick('--text-secondary', 'rgba(248, 250, 252, 0.76)'),
      textTertiary: pick('--text-tertiary', 'rgba(248, 250, 252, 0.62)'),
      textMuted: pick('--text-muted', 'rgba(248, 250, 252, 0.44)'),
      accent: pick('--accent-primary', '#38bdf8'),
    };
  }

var ScreenLookPalette = {
  resolveScreenLookPalette: resolveScreenLookPalette,
  resolveScreenLookNamedPalette: resolveScreenLookNamedPalette,
  resolveScreenLookTypography: resolveScreenLookTypography,
  resolveScreenLookRadiusRoles: resolveScreenLookRadiusRoles,
  resolveScreenLookButton: resolveScreenLookButton,
  resolveScreenLookSpacing: resolveScreenLookSpacing,
  resolveScreenLookTypeRoles: resolveScreenLookTypeRoles,
  MOTION: MOTION,
  nestedCorner: nestedCorner,
  holdingCorner: holdingCorner,
  screenLookFontFamily: screenLookFontFamily,
  readableTextFor: readableTextFor,
  parseHexColor: parseHexColor,
  rgba: rgba,
};

if (typeof globalThis !== 'undefined') {
  globalThis.ScreenLookPalette = ScreenLookPalette;
  globalThis.resolveScreenLookPalette = resolveScreenLookPalette;
}

export {
  MOTION,
  TYPE_ROLES,
  holdingCorner,
  nestedCorner,
  parseHexColor,
  readableTextFor,
  resolveScreenLookNamedPalette,
  resolveScreenLookPalette,
  resolveScreenLookButton,
  resolveScreenLookRadiusRoles,
  resolveScreenLookSpacing,
  resolveScreenLookTypography,
  resolveScreenLookTypeRoles,
  rgba,
  screenLookFontFamily,
};
