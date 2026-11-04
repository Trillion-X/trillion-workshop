// The utility compiler must see Screen Look's theme and variants before it
// expands classes. Appending the raw @theme afterwards leaves controls unpainted.
// Production and source previews use this same input, with the owner's CSS.
export function workspaceUtilitySource(screenLookCss) {
  if (typeof screenLookCss !== 'string' || !screenLookCss.trim()) throw new TypeError('The Screen Look CSS is required.');
  return `@layer base, components;\n@import "tailwindcss/theme";\n@import "tailwindcss/preflight" layer(base);\n@tailwind utilities;\n${screenLookCss}`;
}
