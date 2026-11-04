// parts/screen-look/show/ScreenLookSurface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Screen-look-owned page surface: the look's page-wide styles, and the look the
// person chose painted on the whole page (PaintChosenScreenLook), following
// their records so a pick in Screen look repaints everything at once. When
// their look plan is on (read-data/look-over-time.ts) the page moves between the
// plan's looks over the day by itself, repainted each minute on this device, in
// this device's time zone; nothing is written while it changes. While something
// moves behind the whole page the look's surfaces turn see-through, only as far
// as its words stay readable (read-data/see-through.ts). Choosing
// and editing looks is ChooseScreenLook's, placed where the app puts it, and
// the small Look popover floating in the bottom-right corner of every screen
// (CornerLookButton) when the person turned it on in Screen look.
//
// =============================================================================

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useWorkspacePreference, writeWorkspacePreference } from '#workspace-records';
import { InWindowCorner } from '../../ui/show/floating-occlusion/window-corner';
import type { EditableScreenLookTheme } from '../read-data/read-editable-screen-look-themes';
import { usePageBackdrop } from '../../ui/show/page-backdrop';
import { seeThroughValues } from '../read-data/see-through';
import { LOOK_OVER_TIME, LOOK_PLAN_RECORD, deviceZone, readLookPlan } from '../read-data/look-over-time';
import { lookNow } from '../read-data/look-now';
import { readDeviceScreenLookHeldSince, subscribeDeviceScreenLook } from '../do-work/device-screen-look';
import {
  applyScreenLookTheme, applyScreenLookValues, readPreviewScreenLook, resolveScreenLookCssVariables, subscribePreviewScreenLook,
} from './ApplyCurrentScreenLook';
import { later } from '../../ui/show/load-later/later';
import { notify } from '../../ui/show/coss/notifications';
import { FOLLOW_SYSTEM, kindOfLook, pickMode } from '../read-data/look-follow-system';
import { keepThemeToggle } from './theme-toggle';
import { CORNER_LOOK_BUTTON_PREFERENCE } from './use-screen-look-choices';
import { useScreenLooks } from './use-screen-looks';
import { workFlowMapStyle } from './work-flow-map-style';

// The corner Look button is drawn only while the person keeps its switch on, so its code arrives when it is first drawn.
const ScreenLookPopover = later(() => import('./ScreenLookPopover'), module => module.ScreenLookPopover);

const resolved = new WeakMap<EditableScreenLookTheme, Record<string, string>>();
const valuesOf = (theme: EditableScreenLookTheme) => {
  let values = resolved.get(theme);
  if (!values) { values = resolveScreenLookCssVariables(theme); resolved.set(theme, values); }
  return values;
};

/** Paints the page whenever the person's choice, their looks, their look plan or the minute changes; draws nothing.
 *  A look shown for a moment (the editor's draft) wins; otherwise the plan's blend when it is on and not held to the
 *  worn look; otherwise the worn look. */
function PaintChosenScreenLook() {
  const { chosen, looks, byRule, onThisDevice, follow } = useScreenLooks();
  // The switch between light and dark the keymap runs (theme-toggle.ts): the kind opposite the worn look's own.
  useEffect(() => {
    keepThemeToggle(() => {
      const opposite = FOLLOW_SYSTEM.modes.find(mode => mode.follows === (kindOfLook(chosen) === 'dark' ? 'light' : 'dark'));
      if (!opposite) return;
      writeWorkspacePreference(FOLLOW_SYSTEM.record_key, pickMode(follow, opposite.id, looks, chosen)).catch(() => notify(FOLLOW_SYSTEM.words.failed, { kind: 'error' }));
    });
    return () => keepThemeToggle(null);
  }, [chosen, looks, follow]);
  const planRecord = useWorkspacePreference(LOOK_PLAN_RECORD);
  // A device-only look is held by this device's own record (since when), not by the account's plan.
  const heldSince = useSyncExternalStore(subscribeDeviceScreenLook, readDeviceScreenLookHeldSince, () => null);
  // A look a rule picked for this screen is not moved by the day's plan (read-data/where-looks-apply.ts).
  const plan = React.useMemo(() => {
    if (byRule) return null;
    const accountPlan = readLookPlan(planRecord);
    if (!onThisDevice || !accountPlan?.on || !heldSince) return accountPlan;
    return { ...accountPlan, hold: { kind: 'worn' as const, since: heldSince } };
  }, [planRecord, byRule, onThisDevice, heldSince]);
  const preview = useSyncExternalStore(subscribePreviewScreenLook, readPreviewScreenLook, () => null);
  const [minute, setMinute] = useState(0);
  const planOn = plan?.on === true;
  useEffect(() => {
    if (!planOn) return undefined;
    const tick = () => { if (!document.hidden) setMinute(n => n + 1); };
    const timer = window.setInterval(tick, LOOK_OVER_TIME.repaint_every_ms);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [planOn]);
  // While something moves behind the whole page (page-backdrop), the worn look's surfaces let it show through, as much
  // as its words allow (see-through.json); a look shown for a moment (the editor's draft) stays solid.
  const behind = usePageBackdrop();
  useEffect(() => {
    if (preview) { applyScreenLookTheme(preview); return; }
    const paint = (id: string, values: Record<string, string>) => applyScreenLookValues(id, behind ? seeThroughValues(values) : values);
    const now = lookNow(looks, chosen, plan, new Date(), deviceZone(), valuesOf);
    paint(now.id, now.values);
  }, [chosen, looks, plan, preview, minute, behind]);
  return null;
}

/** The Look popover in the window's bottom-right corner group, next to the other controls there (the message button
 *  keeps the corner itself), drawn on the page so a hidden host still shows it, while the person keeps Screen look's
 *  corner switch on. */
function CornerLookButton() {
  const shown = useWorkspacePreference<boolean>(CORNER_LOOK_BUTTON_PREFERENCE) === true;
  if (!shown) return null;
  return (
    <InWindowCorner corner="bottom-right" order={1}>
      <div
        data-screen-look-surface
        className="rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-surface)]/90 p-2 shadow-[var(--shadow-lg)] backdrop-blur-xl"
      >
        <ScreenLookPopover />
      </div>
    </InWindowCorner>
  );
}

const SCREEN_LOOK_GLOBAL_CSS = `
/* 100vh on a phone is the window with the address bar hidden, so a screen that tall ends under the bar while it shows;
   100dvh is the area a person can see now (the vh line stays only for a browser without dynamic units). */
.account-auth-screen {
  background: var(--bg-primary, #f8f8f8);
  color: var(--text-primary, #111111);
  display: grid;
  grid-template-columns: minmax(22rem, 0.95fr) minmax(24rem, 1.05fr);
  inset: 0;
  min-height: 100vh;
  min-height: 100dvh;
  overflow: auto;
  place-items: stretch;
  position: fixed;
  z-index: 70;
}

.account-auth-brand-panel {
  align-content: center;
  background: color-mix(in srgb, var(--surface-base, #f8f8f8) 84%, var(--text-primary, #111111) 16%);
  border-right: 1px solid color-mix(in srgb, var(--text-primary, #111111) 14%, transparent);
  display: grid;
  gap: clamp(1.3rem, 2.8vw, 2.5rem);
  justify-items: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: clamp(2rem, 5vw, 5rem);
  text-align: center;
}

.account-auth-brand-panel p {
  color: var(--text-secondary, #4b5563);
  font-size: clamp(1.12rem, 1.6vw, 1.45rem);
  font-weight: 740;
  letter-spacing: -0.035em;
  line-height: 1.1;
  margin: 0;
  max-width: 30rem;
}

.account-auth-wordmark {
  align-items: center;
  display: grid;
  gap: clamp(0.7rem, 1.2vw, 1.15rem);
  justify-content: center;
  justify-items: center;
  margin-inline: auto;
  text-align: center;
  width: fit-content;
}

.account-auth-wordmark strong {
  color: var(--text-primary, #111111);
  font-family: var(--font-serif, Georgia, serif);
  font-size: clamp(4rem, 8.4vw, 8.6rem);
  font-weight: 400;
  letter-spacing: 0.02em;
  line-height: 0.9;
  text-rendering: geometricPrecision;
}

.account-auth-mark {
  display: grid;
  gap: clamp(3px, 0.35vw, 7px);
  grid-template-columns: repeat(4, clamp(1rem, 2.2vw, 2.35rem));
  grid-template-rows: repeat(2, clamp(1rem, 2.2vw, 2.35rem));
}

.account-auth-mark span { box-shadow: none; }
.account-auth-mark span:nth-child(1) { background: #e05a5a; }
.account-auth-mark span:nth-child(2) { background: #f5cc42; }
.account-auth-mark span:nth-child(3) { background: #22c0ba; }
.account-auth-mark span:nth-child(4) { background: #9060ee; }
.account-auth-mark span:nth-child(5) { background: #f5a03a; }
.account-auth-mark span:nth-child(6) { background: #35be7a; }
.account-auth-mark span:nth-child(7) { background: #3d7ced; }
.account-auth-mark span:nth-child(8) { background: #e0609a; }

.account-auth-form-panel {
  align-items: center;
  box-sizing: border-box;
  display: grid;
  justify-items: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: clamp(1rem, 5vw, 4rem);
  width: 100%;
}

.account-auth-card {
  background: color-mix(in srgb, var(--surface-base, #f8f8f8) 88%, var(--text-primary, #111111) 12%);
  border: 1px solid color-mix(in srgb, var(--text-primary, #111111) 14%, transparent);
  box-shadow:
    0 24px 80px color-mix(in srgb, var(--text-primary, #111111) 12%, transparent),
    inset 0 1px 0 color-mix(in srgb, white 28%, transparent);
  box-sizing: border-box;
  display: grid;
  gap: clamp(1rem, 2.2vw, 1.65rem);
  justify-items: stretch;
  justify-self: center;
  margin-inline: auto;
  max-width: 38rem;
  padding: clamp(1.25rem, 3.2vw, 2.65rem);
  width: min(100%, 38rem);
}

.account-auth-mobile-brand { display: none; }

.account-auth-copy {
  display: grid;
  gap: 0.6rem;
  justify-items: center;
  text-align: center;
}

.account-auth-copy h1 {
  font-size: clamp(2.25rem, 4.6vw, 4.25rem) !important;
  font-weight: 360 !important;
  letter-spacing: -0.06em !important;
  line-height: 0.98 !important;
  margin: 0;
  max-width: 13ch;
}

.account-auth-copy p {
  margin-inline: auto;
  max-width: 31rem;
}

.account-auth-form {
  display: grid;
  gap: 1rem;
  text-align: left;
}

.account-auth-form label,
.account-auth-card .account-ui-field {
  color: var(--text-secondary, #4b5563);
  display: grid;
  font-size: 0.95rem;
  font-weight: 740;
  gap: 0.45rem;
  line-height: 1.15;
  margin: 0;
  width: 100%;
}

.account-auth-form input,
.account-auth-card .account-ui-input {
  background: color-mix(in srgb, var(--surface-base, #f8f8f8) 82%, white 18%);
  border: 1px solid color-mix(in srgb, var(--text-primary, #111111) 16%, transparent);
  border-radius: 0.9rem;
  box-sizing: border-box;
  color: var(--text-primary, #111111);
  display: block;
  font: inherit;
  font-size: 1rem;
  min-height: 3.25rem;
  outline: none;
  padding: 0 1rem;
  transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease;
  width: 100%;
}

.account-auth-form input::placeholder,
.account-auth-card .account-ui-input::placeholder {
  color: color-mix(in srgb, var(--text-secondary, #4b5563) 72%, transparent);
}

.account-auth-form input:focus,
.account-auth-card .account-ui-input:focus {
  background: color-mix(in srgb, var(--surface-base, #f8f8f8) 92%, white 8%);
  border-color: color-mix(in srgb, var(--accent-blue, #3d7ced) 82%, var(--text-primary, #111111) 18%);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-blue, #3d7ced) 20%, transparent);
}

.account-auth-form button,
.account-auth-card .button-full-width,
.account-auth-card .button-flat-surface,
.account-auth-card .button-hardware-root {
  align-items: center;
  background: color-mix(in srgb, var(--text-primary, #111111) 14%, var(--surface-base, #f8f8f8) 86%);
  border: 0;
  border-radius: 0.9rem;
  box-sizing: border-box;
  color: var(--text-primary, #111111);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-size: 1rem;
  font-weight: 760;
  justify-content: center;
  min-height: 3.25rem;
  padding: 0 1rem;
  text-align: center;
  width: 100%;
}

.account-auth-form button:disabled,
.account-auth-card .button-full-width:disabled,
.account-auth-card .button-flat-surface:disabled,
.account-auth-card .button-hardware-root:disabled {
  color: color-mix(in srgb, var(--text-secondary, #4b5563) 64%, transparent);
  cursor: not-allowed;
  opacity: 0.76;
}

.account-auth-divider {
  align-items: center;
  display: grid;
  gap: 0.85rem;
  grid-template-columns: 1fr auto 1fr;
}

.account-auth-divider span {
  border-top: 1px solid color-mix(in srgb, var(--text-primary, #111111) 14%, transparent);
}

@media (max-width: 900px) {
  .account-auth-screen {
    grid-template-columns: 1fr;
    justify-items: center;
  }

  .account-auth-brand-panel {
    display: none;
  }

  .account-auth-form-panel {
    align-content: center;
    justify-items: center;
    place-items: center;
    padding: clamp(1rem, 5vw, 2.2rem);
    width: 100%;
  }

  .account-auth-card {
    gap: clamp(0.9rem, 3vw, 1.25rem);
    justify-self: center;
    margin-inline: auto;
    padding: clamp(1.25rem, 4vw, 2rem);
    text-align: center;
    width: min(calc(100vw - 2rem), 36rem);
  }

  .account-auth-mobile-brand {
    display: grid;
    gap: 0.65rem;
    justify-items: center;
  }

  .account-auth-mobile-brand .account-auth-wordmark {
    display: grid;
    gap: 0.7rem;
    justify-items: center;
    margin-inline: auto;
    text-align: center;
    width: 100%;
  }

  .account-auth-mobile-brand .account-auth-wordmark strong {
    font-size: clamp(3rem, 13vw, 5rem);
    text-align: center;
  }

  .account-auth-mobile-brand .account-auth-mark {
    gap: clamp(3px, 1vw, 5px);
    grid-template-columns: repeat(4, clamp(0.62rem, 3vw, 0.95rem));
    grid-template-rows: repeat(2, clamp(0.62rem, 3vw, 0.95rem));
  }

  .account-auth-copy h1 {
    font-size: clamp(2.2rem, 10vw, 3.45rem) !important;
  }

  .account-auth-copy p {
    margin-inline: auto;
    max-width: 28rem;
  }
}
`;

export function ScreenLookSurface() {
  return (
    <>
      <style data-screen-look-global-styles>{SCREEN_LOOK_GLOBAL_CSS}</style>
      <style data-screen-look-work-flow-map>{workFlowMapStyle}</style>
      <PaintChosenScreenLook />
      <CornerLookButton />
    </>
  );
}
