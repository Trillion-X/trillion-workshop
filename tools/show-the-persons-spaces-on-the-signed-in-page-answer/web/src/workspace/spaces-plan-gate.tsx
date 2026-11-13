import * as React from 'react';
import { PricingOverlay, type PricingOverlayOffer } from '../../parts/ui/show/pricing-overlay/PricingOverlay';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { planNeededTitle } from './failure';
import { PlanNeeded, postJson } from './api';
import { rememberSpaceInviteForCheckout } from './pending-space-invite.mjs';
import { planCards } from '../plan-cards.mjs';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
function SpacesPlanGate({ needed, onClose }: { needed: PlanNeeded; onClose: () => void }) {
  const [offers, setOffers] = React.useState<PricingOverlayOffer[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let current = true;
    fetch('/billing/offers', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Plans could not load. Try again.')))
      .then((body: { offers: unknown[] }) => {
        if (!current) return;
        setOffers(planCards(body.offers, { buyableNow: true }) as PricingOverlayOffer[]);
        setLoading(false);
      }).catch(() => { if (current) { setError('Plans could not load. Refresh to try again.'); setLoading(false); } });
    return () => { current = false; };
  }, []);
  const choose = React.useCallback(async (id: string) => {
    setBusy(id); setError(null);
    try {
      const answer = await postJson<{ redirect: string }>('/work/api/plan/checkout', { offer_id: id });
      if (!answer.redirect) throw new Error('Checkout could not open. Try again.');
      rememberSpaceInviteForCheckout();
      location.assign(answer.redirect);
    } catch (cause) {
      setError(errorWords(cause, 'Checkout could not open. Try again.'));
      setBusy(null);
    }
  }, []);
  return <PricingOverlay title={planNeededTitle(needed.upgrade_needed)}
    description="Spaces you were invited into stay open on every plan."
    offers={offers} busy={busy} error={error} loading={loading} onChoose={choose} onClose={onClose} />;
}

/** Mounts above the app, over the screen the person was on; closing it leaves them there (`onClose`, which the
 * screen uses to forget the refusal). Only starting a Space is refused, so nothing behind it is withheld. */
export function mountSpacesPlanGate(needed: PlanNeeded, onClose: () => void): () => void {
  const host = document.createElement('div');
  document.body.append(host);
  const unmount = mountReactSurface(host, <SpacesPlanGate needed={needed} onClose={onClose} />);
  return () => { unmount(); host.remove(); };
}
