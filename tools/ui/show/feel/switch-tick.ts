// parts/ui/show/feel/switch-tick.ts
//
// NO PRIOR: searched bitfield-packages/packages/*/show for "switch-tick", "setAttribute('switch'" and
// "ios-haptics" (none), and the 21st.dev MCP for "ios safari haptic switch checkbox" (switch visuals only, no tick).
// The technique is the one tijnjh/ios-haptics and web-haptics use (touch-feel research notes,
// section 4): Safari on iPhone has no Vibration API, but toggling a checkbox drawn as a switch
// (`<input type="checkbox" switch>`, iOS 18 and later) plays the system's selection tick, and clicking the switch's
// label toggles it.
//
// PURPOSE
//   The touch route for a browser on an iPhone or iPad: one system tick, played by clicking a hidden switch's label.
//   It lives in the shared ui part because it builds a native control, which only the shared parts may do.
//
// NON-NEGOTIABLE INVARIANTS
//   1. It plays only inside a real tap (the browser's user activation is active); outside one Safari plays nothing, so
//      it says it could not (false) and the next route is tried.
//   2. It plays only on an iPhone or iPad browser that supports the switch (iOS 18 and later); anywhere else it says no.
//   3. The switch is hidden from sight and from assistive technology, made once per page, and never takes focus.
//   4. One tick per call, whatever the feel's pattern: the platform gives no strength or timing.
//
// The extensive documentation in this codebase is a critical design feature. You are forbidden from simplifying
// or removing it.

let label: HTMLLabelElement | null = null;

const onApplePhone = () => typeof navigator !== 'undefined'
  && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

const inTap = () => Boolean((navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive);

// iOS 18 and later know the `switch` attribute and draw the checkbox as one.
const supportsSwitch = () => typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;

function switchLabel(): HTMLLabelElement {
  if (label?.isConnected) return label;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('switch', '');
  box.tabIndex = -1;
  label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.setAttribute('data-feel-switch', '');
  label.hidden = true;
  label.append(box);
  document.head.append(label);
  return label;
}

/** Plays one system tick on an iPhone or iPad browser inside a real tap; false when it cannot here. */
export function switchTick(): boolean {
  if (typeof document === 'undefined' || !onApplePhone() || !supportsSwitch() || !inTap()) return false;
  switchLabel().click();
  return true;
}
