// tools/welcome-a-buyer-back-after-checkout/show/Welcome.tsx
//
// PURPOSE
//   The screen of tool:read-the-welcome-page: the page a buyer comes back to after checkout. It says what the buyer's checkout
//   came to (paid, still waiting, or none was named) in the words the pursuit's rows give for that state, with one button per
//   action. A page row places it with plain JSON props and it finds the checkout's state itself, once it is mounted.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Rendering is pure: nothing is fetched and no window is read while it renders; the server draws the state `none`. After
//      it is mounted, an effect reads `?checkout=` from the address and, when one is named, asks
//      `<status_path>?checkout=<id>` (answering { state }); a failed or unreadable answer is the state `waiting`.
//   2. Every word is a state of `states`; a state the rows do not hold falls back to `none`, and a page with no `none` state
//      draws nothing.
//   3. Props are plain JSON: `states`, `status_path`.
//   4. Built from the marketing-page parts (SectionShell, TextColumn, StatementText, Text, CtaBlock); a heading's last word is
//      drawn solid.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React, { useEffect, useState } from 'react';
import { CtaBlock, SectionShell, StatementText, Text, TextColumn } from '../../ui/show/marketing-page/MarketingPagePrimitives.tsx';
import type { WelcomeState } from '../reads/read-the-welcome-page.ts';

export type WelcomeProps = {
  states: Record<string, WelcomeState>;
  status_path?: string;
};

export function View({ states, status_path = '/target/checkout-status' }: WelcomeProps) {
  const [state, setState] = useState('none');
  useEffect(() => {
    const checkout = new URLSearchParams(window.location.search).get('checkout') ?? '';
    if (checkout === '') return;
    void fetch(`${status_path}?checkout=${encodeURIComponent(checkout)}`)
      .then(response => (response.ok ? response.json() : { state: 'waiting' }))
      .catch(() => ({ state: 'waiting' }))
      .then((answer: { state?: unknown }) => setState(typeof answer.state === 'string' ? answer.state : 'waiting'));
  }, [status_path]);
  const section = states[state] ?? states.none;
  if (!section) return null;
  const at = section.heading.lastIndexOf(' ') + 1;
  return (
    <SectionShell paddingY="hero" size="narrow">
      <TextColumn align="center">
        <StatementText align="center" lines={[[{ text: section.heading.slice(0, at) }, { text: section.heading.slice(at), solid: true }]]} />
        <Text color="muted">{section.body}</Text>
        {section.actions.map(action => <CtaBlock key={action.href} href={action.href} label={action.label} />)}
      </TextColumn>
    </SectionShell>
  );
}
