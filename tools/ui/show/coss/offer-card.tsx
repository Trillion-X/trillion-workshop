// parts/ui/show/coss/offer-card.tsx
//
// PURPOSE
//   One offer at a glance, drawn from a guide section's `offer` DATA: a small title, the price large in the display
//   face with how often it is paid beside it, then what comes with it as a feature list, each line's opening words in
//   bold and a check in a round tile before it. Anatomy follows 21st.dev's single-plan pricing cards (ln-dev7
//   "pricing-17", felipemenezes098 "card-09", cnippet "v-card-18"): price first, a divider, a checklist whose key words
//   carry the weight. Dropped from them: the "Popular" ribbon, the compare-at price and the card's own button (the
//   section's actions are the buttons, so a card never holds a second way to pay).
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no product words: title, price, how often and every feature line are the caller's DATA.
//   2. A feature's `lead` is its bold opening words and `rest` the remainder of the same line, so the line reads as
//      one sentence and the emphasis is DATA, never parsed out of a string.
//   3. Appearance lives in screen-look/show/guide.css (`.offer-card-*`).

import * as React from 'react';
import { Check } from 'lucide-react';
import type { GuideOffer } from './guide';

export function OfferCard({ offer }: { offer: GuideOffer }) {
  return (
    <div className="offer-card">
      <div className="offer-card-top">
        {offer.title ? <p className="offer-card-title">{offer.title}</p> : null}
        {offer.price ? (
          <p className="offer-card-price">
            <span className="offer-card-amount">{offer.price}</span>
            {offer.price_note ? <span className="offer-card-per">{offer.price_note}</span> : null}
          </p>
        ) : null}
      </div>
      {offer.features.length ? (
        <ul className="offer-card-features">
          {offer.features.map(feature => (
            <li key={feature.lead} className="offer-card-feature">
              <span className="offer-card-mark" aria-hidden><Check /></span>
              <span className="offer-card-line"><strong className="offer-card-lead">{feature.lead}</strong>{feature.rest ? ` ${feature.rest}` : null}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
