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
export const CARD_CADENCE = { fontSize: '.95rem', fontWeight: 650, letterSpacing: 'normal', marginLeft: 6, opacity: 0.7 } as const;
export const CARD_NOTE = { background: 'rgba(37,148,107,.1)', border: '1px solid rgba(37,148,107,.28)', borderRadius: 12, color: 'rgba(15,23,42,.86)', fontSize: 'clamp(1rem,1.35vw,1.08rem)', fontWeight: 730, lineHeight: 1.45, margin: '1.08rem 0', padding: '14px 16px' } as const;

// What a buyer typed as an amount of money (dollars, with or without cents), in cents; null when it is not an amount.
export const centsOf = (typed: string): number | null => {
  const text = typed.trim().replace(/^[^\d.]+/, '').replace(/,/g, '');
  return /^\d+(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null;
};
