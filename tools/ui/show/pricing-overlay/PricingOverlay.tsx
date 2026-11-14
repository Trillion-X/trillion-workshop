// A reusable, viewport-sized pricing dialog (the shared StepOverlay holding the plans), and the plan cards it shows
// (also used on their own, compact, where a dialog does not fit). The caller owns offer facts and checkout.
import { ComparisonTable } from '../comparison-table/ComparisonTable';
import { planCardHtml } from '../plan-card/plan-card-html.mjs';
import { PLAN_CARD_CSS } from 'trillion-workshop/tools/screen-look/show/plan-card-style.mjs';

export type PlanLine = { id: string; label: string; included: boolean; value?: string };
import { StepOverlay } from '../step-overlay/StepOverlay';

export type PricingOverlayOffer = {
  id: string; name: string; price: string; recommended: boolean; priced: boolean;
  lines: readonly PlanLine[]; notes: readonly string[];
  /** The plan's own button words; "Choose this plan" when it names none. */
  action?: string;
};

/**
 * The plans side by side, each a plan card with its Choose button. `compact` is the small form for a narrow place
 * (a browser extension's popup): smaller type, and only the lines that differ between the plans, since what every
 * plan has decides nothing.
 */
export function PlanCards({ offers, busy, onChoose, compact = false, lineLimit }: {
  offers: readonly PricingOverlayOffer[]; busy?: string | null; onChoose: (id: string) => void; compact?: boolean;
  /** At most this many lines per card (the first ones), for a place with no room for the whole list. */
  lineLimit?: number;
}) {
  const differs = (id: string) => new Set(offers.map(offer => {
    const line = offer.lines.find(candidate => candidate.id === id);
    return line ? `${line.included}:${line.value ?? ''}` : 'false:';
  })).size > 1;
  const html = offers.map(offer => planCardHtml({
    id: offer.id, name: offer.name, price: offer.price, recommended: offer.recommended,
    lines: (compact ? offer.lines.filter(line => differs(line.id)) : offer.lines).slice(0, lineLimit),
    notes: offer.notes, linesLabel: `${offer.name} includes`,
    action: offer.priced ? { label: busy === offer.id ? 'Opening checkout…' : offer.action ?? 'Choose this plan', href: '#checkout' } : undefined,
  })).join('');
  return <>
    <style>{PLAN_CARD_CSS}</style>
    <ul className="trillion-plan-cards" data-compact={compact ? 'true' : undefined}
      onClick={event => {
        const anchor = event.target instanceof Element ? event.target.closest('[data-plan-action]') : null;
        if (!anchor) return;
        event.preventDefault();
        const id = anchor.closest('[data-plan-id]')?.getAttribute('data-plan-id');
        if (id && !busy) onChoose(id);
      }}
      dangerouslySetInnerHTML={{ __html: html }} />
  </>;
}

export function PricingOverlay({ title, description, offers, loading = false, busy, error, onChoose, onClose }: {
  title: string; description: string; offers: readonly PricingOverlayOffer[];
  loading?: boolean; busy?: string | null; error?: string | null;
  onChoose: (id: string) => void; onClose: () => void;
}) {
  const plans = offers.filter(offer => offer.lines.length);
  return (
    <StepOverlay title={title} description={description} onClose={onClose} closeLabel="Close pricing" width="wide" marker="pricing">
      {offers.length ? <PlanCards offers={offers} busy={busy} onChoose={onChoose} /> : loading ? <p className="step-overlay__message" role="status">Loading current plans…</p> : null}
      {error ? <p className="step-overlay__message" role="alert">{error}</p> : null}
      {plans.length > 1 ? <ComparisonTable caption="Compare plans" featureHeading="What you get" density="compact"
        columns={plans.map(offer => ({ id: offer.id, name: offer.name, detail: offer.price, highlighted: offer.recommended }))}
        rows={plans[0].lines.map(line => ({ id: line.id, label: line.label, cells: plans.map(offer => {
          const own = offer.lines.find(candidate => candidate.id === line.id);
          return own ? { included: own.included, value: own.value } : { included: false };
        }) }))} /> : null}
    </StepOverlay>
  );
}
