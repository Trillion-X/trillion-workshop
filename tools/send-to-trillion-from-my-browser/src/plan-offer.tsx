// extension/src/plan-offer.tsx
//
// PURPOSE
//   When the person's free account asks for something only a paid plan does (saving a chat, a page tool, keeping a
//   file), the popup shows this instead of an error: what a paid plan unlocks (the same title the web app shows,
//   src/plan-needs.mjs needsPlanTitle), and the free and paid plans as two small cards side by side, the same
//   cards and DATA the web app's plan gate shows (parts/ui PlanCards over src/plan-cards.mjs). Choosing the paid plan
//   opens that offer's Buy on Trillion with from=extension and the page they were on (src/trillion.mjs buyAddress);
//   after paying, Trillion's welcome takes them back. Buy pays for the account signed in on Trillion in this browser,
//   so when nobody is signed in there the card says to sign in first and Choose opens the sign-in instead. Only the
//   free plan and the paid plan to pick (the recommended one) are shown; the full comparison is on Plan & billing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Built from the shared parts; the plans, their lines and the title are the service's DATA, never written here.
//   2. It shows while session storage holds `plan_needed`; Not now forgets it.
//   3. Buy is never opened while this browser is signed out of Trillion, so a payment never makes a second account.

import React from 'react';
import { Button } from 'trillion-workshop/tools/ui/show/button/index.ts';
import { Container } from 'trillion-workshop/tools/ui/show/container/index.ts';
import { Text } from 'trillion-workshop/tools/ui/show/text/index.ts';
import { PlanCards, type PricingOverlayOffer } from 'trillion-workshop/tools/ui/show/pricing-overlay/PricingOverlay.tsx';
import { needsPlanTitle } from 'trillion-workshop/tools/workspace-screens/web/src/plan-needs.mjs';
import { buyAddress, ORIGIN, readPlans, signedInOnTrillion } from './trillion.mjs';
import words from '../words.json' with { type: 'json' };

export type PlanNeededNote = { feature: { id: string; label: string } | null; at: number };

export function PlanOffer({ needed, page }: { needed: PlanNeededNote; page: string | null }) {
  const [plans, setPlans] = React.useState<PricingOverlayOffer[] | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [signedInHere, setSignedInHere] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    // Free beside the one paid plan to pick: the recommended one, else the first priced.
    readPlans().then((read: PricingOverlayOffer[]) => {
      const free = read.find(plan => !plan.priced);
      const paid = read.find(plan => plan.priced && plan.recommended) ?? read.find(plan => plan.priced);
      setPlans([free, paid].filter(Boolean) as PricingOverlayOffer[]);
    }, () => setProblem(words.plan.could_not_load));
  }, []);
  React.useEffect(() => { signedInOnTrillion().then(setSignedInHere); }, []);
  const signInThere = () => chrome.tabs.create({ url: `${ORIGIN}${words.plan.sign_in_path}` });
  // Asked again at the press, since the person may have signed in on Trillion since this opened.
  async function choose(id: string) {
    const here = await signedInOnTrillion();
    setSignedInHere(here);
    if (!here) { signInThere(); return; }
    await chrome.tabs.create({ url: buyAddress(id, page) });
  }
  return (
    <Container layout="vertical" gap="sm" padding="sm" rounded="lg" border="all" width="full" role="region" aria-label={needsPlanTitle(needed.feature?.id ?? null)}>
      <Container layout="vertical" gap="none" width="full">
        <Text variant="body-xs" weight="medium">{needsPlanTitle(needed.feature?.id ?? null)}</Text>
        <Text variant="caption" color="muted">{words.plan.detail}</Text>
      </Container>
      {signedInHere === false ? (
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" width="full">
          <Text variant="caption" color="muted" className="flex-1">{words.plan.sign_in_first}</Text>
          <Button variant="secondary" size="xs" onClick={signInThere}>{words.plan.sign_in}</Button>
        </Container>
      ) : null}
      {plans ? <PlanCards offers={plans} onChoose={choose} compact lineLimit={words.plan.lines_shown} /> : problem ? null : <Text variant="caption" color="muted">{words.plan.loading}</Text>}
      {problem ? <Text variant="caption" color="error">{problem}</Text> : null}
      <Button variant="ghost" size="xs" onClick={() => chrome.storage.session.remove('plan_needed')}>{words.plan.not_now}</Button>
    </Container>
  );
}
