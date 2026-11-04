// One look for the plan card in server pages, the workspace, and compact hosts.
// All colours and faces come from the worn screen look or the page's mapped roles.
export const PLAN_CARD_CSS = `
.page-layout--auth .page-main:has(.trillion-plan-cards){max-width:72rem}
.page-layout--auth .page-main:has(.trillion-plan-cards) .page-section--welcome,.page-layout--auth .page-main:has(.trillion-plan-cards) .page-section--fine{max-width:24rem;margin-inline:auto}
.page-layout--auth .page-section:has(.trillion-plan-cards){margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--border-primary)}
.page-layout--auth .page-section:has(.trillion-plan-cards)>.page-heading,.page-layout--auth .page-section:has(.trillion-plan-cards)>.page-body{max-width:42rem;margin-inline:auto;text-align:center}
.trillion-plan-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:1rem;margin:1.5rem 0 0;padding:0;list-style:none}
.trillion-plan-card{display:flex;flex-direction:column;min-width:0;gap:1rem;padding:1.5rem;border:1px solid var(--border-primary);border-radius:var(--radius-card);background:var(--bg-surface);color:var(--text-primary);box-shadow:0 10px 28px -24px var(--text-primary)}
.trillion-plan-card[data-highlighted="true"]{border-color:var(--button-primary-bg);background:color-mix(in srgb,var(--bg-surface) 94%,var(--button-primary-bg))}
.trillion-plan-card__head{display:grid;gap:.45rem}.trillion-plan-card__name{margin:0;font:650 1.45rem/1.2 var(--font-display)}
.trillion-plan-card__price{margin:0;font:650 clamp(1.25rem,2.2vw,2rem)/1.2 var(--font-primary);overflow-wrap:anywhere}
.trillion-plan-card__summary{margin:0;color:var(--text-secondary);font:400 .92rem/1.5 var(--font-primary)}
.trillion-plan-card__action{display:flex;align-items:center;justify-content:space-between;gap:.6rem;min-height:2.8rem;box-sizing:border-box;padding:.65rem .9rem;border:1px solid var(--border-secondary);border-radius:var(--radius-control);background:var(--button-primary-bg);background-image:var(--button-sheen);color:var(--button-primary-text);font:600 .9rem/1.2 var(--font-primary);text-decoration:none;box-shadow:var(--button-highlight),var(--button-shadow)}
.trillion-plan-card__action:hover{background-color:var(--button-primary-bg-hover)}
.trillion-plan-card__action:focus-visible{outline:2px solid var(--border-focus);outline-offset:3px}
.trillion-plan-card__features{display:grid;align-content:start;gap:.7rem;margin:0;padding:0;list-style:none;flex:1}
.trillion-plan-card__features li{display:grid;grid-template-columns:1.15rem minmax(0,1fr);gap:.55rem;align-items:start;font:400 .88rem/1.45 var(--font-primary)}
.trillion-plan-card__features li[data-included="false"]{color:var(--text-secondary)}
.trillion-plan-card__mark{display:inline-flex;align-items:center;height:1.3em;font-weight:700;color:var(--button-primary-bg)}
.trillion-plan-card__value{display:block;font-weight:600}
.trillion-plan-card__sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.trillion-plan-cards[data-compact="true"]{grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr));gap:.6rem;margin:0}
.trillion-plan-cards[data-compact="true"] .trillion-plan-card{padding:.85rem;gap:.55rem}.trillion-plan-cards[data-compact="true"] .trillion-plan-card__name{font-size:1rem}.trillion-plan-cards[data-compact="true"] .trillion-plan-card__price{font-size:1.2rem}.trillion-plan-cards[data-compact="true"] .trillion-plan-card__features li{font-size:.75rem;gap:.3rem}
@media(max-width:40rem){.trillion-plan-cards{grid-template-columns:minmax(0,1fr)}}
@media(prefers-reduced-motion:reduce){.trillion-plan-card__action:hover{transform:none}}
`;
