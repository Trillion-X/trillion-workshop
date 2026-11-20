// tools/workspace-screens/web/members-page/rows.mjs
//
// PURPOSE
//   The pure rules the members page applies to its rows and host values, kept apart from the page so they test without a
//   browser: which screen modules a set of packages holds, which screen a sidebar row names, and which host values a row takes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A screen module is a `*-screen-mount.tsx` file anywhere under a package's web/ folder. Its key is
//      `<package>/<file name without .tsx>`: the key a sidebar row's package_entry names, and the key a screen opens another
//      screen by (the course list opens its lesson by `lessons-and-learning-paths/course-lesson-screen-mount`).
//   2. (registry.mjs) Two modules with one key are refused, so a key always means one file.
//   3. A row passes a screen only the host values its own surface_input names in `host_input`; nothing else reaches a screen.

export const SCREEN_FILE = /-screen-mount\.tsx$/;

/** The key of a screen module: its package and its file name without the extension. */
export const screenKeyOf = (packageName, file) => `${packageName}/${file.replace(/^.*\//, '').replace(/\.tsx$/, '')}`;

/** The key of the screen a sidebar row names (its package_entry). */
export const surfaceKeyOf = surface => `${surface.payload.package_entry.package_name}/${surface.payload.package_entry.entry_name}`;

/** The input a screen is mounted with: the row's own surface_input, plus the host values its host_input names. */
export function screenInputOf(surfaceInput, host) {
  const { host_input: names = [], ...given } = surfaceInput ?? {};
  const taken = Object.fromEntries(names.filter(name => name in host).map(name => [name, host[name]]));
  return { ...given, ...taken };
}
