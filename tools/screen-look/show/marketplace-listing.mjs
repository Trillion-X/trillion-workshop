// Generic Marketplace detail-page appearance. The page writer owns the HTML;
// this module owns only the reusable responsive look for listing data.
export const MARKETPLACE_LISTING_CSS = String.raw`
.page-layout.page-layout--marketplace{max-width:72rem;margin:0 auto;padding-bottom:1.5rem}
.page-layout--marketplace .page-section{max-width:64rem}
.page-layout--marketplace .page-section--hero{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem;align-items:start;padding-top:3.25rem;padding-bottom:2.5rem;border-bottom:0}
.page-layout--marketplace .page-section--hero .page-mark{grid-row:1 / span 3;width:4.5rem;height:4.5rem;margin:0 0 .5rem;display:grid;place-items:center;border-radius:1.25rem;background:var(--page-ink);color:var(--page-bg);font-family:var(--page-display);font-size:1.5rem;font-weight:600;object-fit:cover}
.page-layout--marketplace .page-section--hero .page-heading{max-width:54rem;margin-bottom:.5rem;font-size:clamp(2.5rem,4.2vw,3.75rem);letter-spacing:-.035em}
.page-layout--marketplace .page-section--hero .page-body{max-width:42rem;font-size:clamp(1.1rem,2vw,1.35rem);line-height:1.55;color:var(--page-soft)}
.page-layout--marketplace .page-section--components{max-width:72rem;padding-top:1.5rem;padding-bottom:1.5rem;background:color-mix(in srgb,var(--page-card) 46%,transparent);border:1px solid var(--page-line);border-radius:1.5rem}
.page-layout--marketplace .page-section--components .page-heading{font-size:1.15rem;font-family:var(--page-font);font-weight:700;margin-bottom:.25rem}
.page-layout--marketplace .page-section--components .page-items{margin-top:1rem;gap:1rem}
.page-layout--marketplace .page-section--components .page-item:only-child{grid-column:1 / -1;width:100%;box-sizing:border-box}
.page-layout--marketplace .page-section--components .page-item{padding:1.15rem 1.25rem;border:1px solid var(--page-line);border-radius:1rem;background:var(--page-card);box-shadow:0 8px 24px -24px color-mix(in srgb,var(--page-ink) 20%,transparent)}
.page-layout--marketplace .page-section--components .page-item-heading{font-size:1.1rem}
.page-layout--marketplace .page-section--components .page-item-body{font-size:.95rem}
.page-layout--marketplace .page-section--components .page-item-meta{font-size:.72rem;}
.page-layout--marketplace .page-section--benefit{padding-top:2rem;padding-bottom:2rem}
.page-layout--marketplace .page-section--benefit .page-heading{font-size:clamp(1.8rem,4vw,3rem)}
.page-layout--marketplace .page-section--benefit .page-body{font-size:1.1rem}
.page-layout--marketplace .page-section--cta{position:relative;display:flex;align-items:center;justify-content:space-between;gap:1.5rem;max-width:72rem;margin:.5rem auto 1.5rem;padding:1.25rem 1.5rem;border:1px solid var(--page-line-strong);border-radius:1.25rem;background:color-mix(in srgb,var(--page-card) 96%,transparent);box-shadow:0 6px 18px -18px rgba(25,25,25,.3);backdrop-filter:blur(14px)}
.page-layout--marketplace .page-section--cta .page-heading{margin:0;font-family:var(--page-font);font-size:1.05rem;font-weight:700}
.page-layout--marketplace .page-section--cta .page-body{font-size:.9rem}
.page-layout--marketplace .page-section--cta .page-actions{margin:0;flex:none}
.page-layout--marketplace .page-section--cta .page-action{white-space:nowrap}
@media(min-width:48rem){.page-layout--marketplace .page-section--hero{grid-template-columns:6rem minmax(0,1fr);column-gap:1.5rem;padding-top:2.75rem;padding-bottom:2rem}.page-layout--marketplace .page-section--hero .page-mark{grid-row:1 / span 2}.page-layout--marketplace .page-section--hero .page-heading,.page-layout--marketplace .page-section--hero .page-body{grid-column:2}.page-layout--marketplace .page-section--components{padding:1.5rem 2rem}.page-layout--marketplace .page-section--benefit{padding-left:3rem;padding-right:3rem}}
@media(max-width:40rem){.page-layout--marketplace .page-section{padding-left:1.25rem;padding-right:1.25rem}.page-layout--marketplace .page-section--hero{padding-top:3rem}.page-layout--marketplace .page-section--components{padding-top:1.25rem;padding-bottom:1.25rem}.page-layout--marketplace .page-section--cta{position:relative;display:block;margin:1rem 1rem 1.5rem;padding:1.1rem}.page-layout--marketplace .page-section--cta .page-actions{margin-top:1rem}.page-layout--marketplace .page-section--cta .page-action{width:100%}}
@media(prefers-reduced-motion:reduce){.page-layout--marketplace .page-action{transition:none}}
`;
