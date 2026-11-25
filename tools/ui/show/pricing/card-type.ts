// tools/ui/show/pricing/card-type.ts
//
// PURPOSE
//   The type of a price card and a contact card as the program's pages have always set it: the plan's name and price in the
//   display family, the line under them as a quiet note box. One place, so both cards read as one pair.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Plain style data only: no markup, no fetch, no window.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
const DISPLAY = '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const CARD_NAME = { color: '#0f172a', fontFamily: DISPLAY, fontSize: 'clamp(1.95rem,2.6vw,2.6rem)', fontWeight: 700, letterSpacing: '-.035em', lineHeight: 1.05, margin: 0 } as const;
export const CARD_PRICE = { color: '#0f172a', fontFamily: DISPLAY, fontSize: 'clamp(2.925rem,4vw,3.5rem)', fontWeight: 700, letterSpacing: '-.045em', lineHeight: 1, margin: 0 } as const;
/** A card that draws its own surface (`framed`): the program pages' white card, 460 wide, its padding easing in on a phone. */
export const CARD_FRAME = { background: 'rgba(255,255,255,.72)', border: '1px solid rgba(15,23,42,.12)', borderRadius: 22, boxShadow: '0 18px 50px -22px rgba(15,23,42,.28)', boxSizing: 'border-box', padding: 'clamp(20px,2.03vw,26px) clamp(16px,2.03vw,26px) clamp(18px,1.72vw,22px)', width: 'min(460px, 100%)' } as const;
/** A field's label and the line under a card's button, as the program pages set them. */
export const CARD_LABEL = { color: 'var(--field-label-ink, inherit)', fontSize: '15px', fontWeight: 400, lineHeight: 1.5 } as const;
export const CARD_FIELD = { gap: 6 } as const;
export const CARD_FOOT = { color: 'rgba(15,23,42,.62)', fontSize: '15px', letterSpacing: '-.15px', margin: '15px 0', textAlign: 'center' } as const;
/** The line that says what a price starts at, above the buttons: the look's own ink, else a quiet one. */
export const CARD_LINE = { color: 'var(--pricing-line-ink, rgba(15,23,42,.62))', margin: '16px 0' } as const;
/** The head of a card (its name and price, or its title): a rule under it. */
export const CARD_HEAD = 'grid gap-[14px] border-b border-[rgba(15,23,42,.1)] pb-[18px]';
/** A box a person types in, from the look: the corner, line, fill, shadow, height and size its pages gave them. */
export const CARD_FIELD_BOX = 'rounded-[var(--field-radius,0.5rem)] border-[color:var(--field-border,var(--color-input))] bg-[var(--field-bg,var(--color-background))] shadow-[var(--field-shadow,0_1px_2px_0_rgb(0_0_0/0.05))]';
export const CARD_FIELD_TEXT = { height: 'var(--field-height, 2.125rem)', fontSize: 'var(--field-font-size, inherit)', color: 'var(--field-ink, inherit)' } as const;
export const CARD_CADENCE = { color: 'rgba(15,23,42,.55)', fontFamily: 'var(--font-primary, inherit)', fontSize: '.95rem', fontWeight: 650, letterSpacing: 'normal', marginLeft: 6 } as const;
export const CARD_FEATURE = { color: '#172033', fontSize: 'clamp(1rem,1.35vw,1.08rem)', fontWeight: 680, lineHeight: 1.45 } as const;
export const CARD_NOTE = { background: 'rgba(0,134,82,.08)', border: '1px solid rgba(0,134,82,.25)', borderRadius: 14, color: 'rgba(15,23,42,.86)', fontSize: 'clamp(1rem,1.35vw,1.08rem)', fontWeight: 730, lineHeight: 1.45, margin: '1.08rem 0', padding: '14px 16px' } as const;

// What a buyer typed as an amount of money (dollars, with or without cents), in cents; null when it is not an amount.
export const centsOf = (typed: string): number | null => {
  const text = typed.trim().replace(/^[^\d.]+/, '').replace(/,/g, '');
  return /^\d+(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null;
};
