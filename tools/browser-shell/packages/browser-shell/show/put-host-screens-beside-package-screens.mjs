// packages/browser-shell/show/put-host-screens-beside-package-screens.mjs
//
// PURPOSE
//   Lets a host app's own screens sit in Bitfield tabs, splits and sidebars as
//   equals of package screens. Every placed surface asks the page's on-screen
//   runner to put `package::<package>::entry-bytes::<entry>` in an element. This
//   wraps that runner: an entry under the host's own package name is mounted by
//   the host, and every other entry goes to the runtime exactly as before.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the host's own package name is intercepted. A runtime package is
//      never shadowed.
//   2. The host's cleanup is registered where the shared mount host looks for
//      it (`_thingToPutOnScreenCleanup` on the element), so closing a tab tears
//      down a host screen the same way it tears down a package screen.
//   3. The runner's other methods are untouched (prototype delegation).

export function putHostScreensBesidePackageScreens(runner, {packageName, mountScreen}) {
  if (!runner || typeof runner.putSourceBytesOnScreen !== 'function') throw new Error('An on-screen runner is required.');
  if (typeof packageName !== 'string' || !packageName) throw new Error('Name the host package.');
  const prefix = `package::${packageName}::entry-bytes::`;
  const wrapped = Object.create(runner);
  wrapped.putSourceBytesOnScreen = request => {
    const label = request?.sourceBytes?.address_label;
    if (typeof label !== 'string' || !label.startsWith(prefix)) return runner.putSourceBytesOnScreen(request);
    const element = request.screenPlace?.element ?? request.screenPlace;
    const cleanup = mountScreen(label.slice(prefix.length), element, request.props ?? {});
    element._thingToPutOnScreenCleanup = typeof cleanup === 'function' ? cleanup : null;
    return undefined;
  };
  return wrapped;
}
