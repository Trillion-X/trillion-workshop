// parts/ui/show/show-rules/ShowRuleMenu.tsx
//
// NO PRIOR: searched bitfield-packages/packages/*/show for "mute", "snooze", "silence" (no per-thing menu) and
// 21st.dev for "notification mute snooze menu" (Menubar Compact #29428: an overflow icon opening a short menu).
// References (anatomy only): Mobbin Luma group menu (Mute for 1 hour / 1 day / 1 week, a line, Mute forever), Quo Do
// not disturb (the spans, then Turn Off with "Set until 12:58 PM"), Substack Pause notifications (For 1 hour ... Until
// I change it).
//
// PURPOSE
//   The small menu on any shown thing (a notice, a tour card, a layout row) that silences or hides things like it: the
//   thing's heading, the quick choices the app's DATA offers (For 1 hour, Until tomorrow, Always, Only on this phone),
//   and, when rules hold it now, each one offered back to turn off. Its button shows the choice being made, done, or
//   failed, inside itself.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a subject or a choice: the words and choices come from the page's answerer (show-of.ts).
//   2. With no answerer installed it draws nothing.
//   3. A choice made shows on the trigger: busy while it is kept, a check when kept, an alert when it failed (with the
//      failure as the trigger's name until the next press).
//   4. Pressing the trigger never presses the row it sits on.

import React from 'react';
import {BellOff, Check, CircleAlert} from 'lucide-react';
import {Spinner} from '../spinner';
import {Button} from '../coss/ui/button';
import {Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger} from '../coss/ui/menu';
import {chooseShow, removeShowRule, showMenu, useShowChange, type ShowThing} from './show-of';
import {errorWords} from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';

type State = {kind: 'ready'} | {kind: 'busy'} | {kind: 'done'} | {kind: 'failed'; words: string};
const DONE_SHOWN_MS = 1600;

export interface ShowRuleMenuProps {
  subject: string;
  thing: ShowThing;
  /** The trigger's name for people who cannot see its icon. */
  label?: string;
  className?: string;
}

export function ShowRuleMenu({subject, thing, label, className}: ShowRuleMenuProps): React.ReactElement | null {
  useShowChange();
  const [state, setState] = React.useState<State>({kind: 'ready'});
  const menu = showMenu(subject, thing);
  React.useEffect(() => {
    if (state.kind !== 'done') return undefined;
    const timer = window.setTimeout(() => setState({kind: 'ready'}), DONE_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [state.kind]);
  if (!menu || (!menu.choices.length && !menu.holding.length)) return null;
  const run = async (work: () => Promise<void>) => {
    setState({kind: 'busy'});
    try { await work(); setState({kind: 'done'}); }
    catch (error) { setState({kind: 'failed', words: errorWords(error)}); }
  };
  const Icon = state.kind === 'done' ? Check : state.kind === 'failed' ? CircleAlert : BellOff;
  const name = state.kind === 'failed' ? state.words : label ?? menu.heading;
  return (
    <span className={className} data-slot="show-rule-menu" data-state={state.kind} onClick={event => event.stopPropagation()}>
      <Menu>
        <MenuTrigger render={<Button type="button" size="icon-sm" variant="ghost" aria-label={name} title={name} disabled={state.kind === 'busy'} />}>
          {state.kind === 'busy' ? <Spinner size="sm" aria-hidden /> : <Icon aria-hidden="true" />}
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" data-slot="show-rule-menu-popup">
          <MenuGroup>
            <MenuGroupLabel>{menu.heading}</MenuGroupLabel>
            {menu.choices.map(choice => (
              <MenuItem key={choice.id} data-choice={choice.id} onClick={() => { void run(() => chooseShow(subject, thing, choice.id)); }}>
                {choice.label}
              </MenuItem>
            ))}
          </MenuGroup>
          {menu.holding.length ? <MenuSeparator /> : null}
          {menu.holding.map(rule => (
            <MenuItem key={rule.id} data-rule={rule.id} onClick={() => { void run(() => removeShowRule(rule.id)); }}>
              {rule.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </span>
  );
}
