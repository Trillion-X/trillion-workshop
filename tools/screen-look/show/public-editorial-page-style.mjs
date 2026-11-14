// Shared reading appearance for public pages that select the generic article
// layout. Product colors remain page DATA through --sales-* variables.
export const PUBLIC_EDITORIAL_PAGE_CSS = `
body:has(.public-sales-page[data-layout="article"]) {
  margin: 0;
  background: #f5f7f5;
  color: var(--sales-text, #26333b);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
body:has(.public-sales-page[data-layout="article"])::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 100;
  pointer-events: none;
  background-image: var(--landing-page-grain), var(--landing-page-grain), var(--landing-page-grain);
  background-position: 0 0, 83px 41px, 151px 97px;
  background-size: 128px 128px, 256px 256px, 96px 96px;
  filter: contrast(235%) brightness(1) grayscale(1);
  mix-blend-mode: soft-light;
  opacity: .195;
}
.public-sales-page[data-layout="article"] {
  background: color-mix(in srgb, var(--sales-ground, #fff) 92%, #fbfaf6 8%);
  color: var(--sales-text, #26333b);
}
.public-sales-page[data-layout="article"] * { box-sizing: border-box; }
.public-sales-page[data-layout="article"] a { color: inherit; text-decoration-color: var(--sales-accent, #5e9677); text-underline-offset: .22em; }
.public-sales-page[data-layout="article"] a:hover { color: var(--sales-accent, #5e9677); }
.public-sales-page[data-layout="article"] a:focus-visible { outline: 3px solid var(--sales-accent, #5e9677); outline-offset: 4px; border-radius: 3px; }
.public-sales-page[data-layout="article"] .public-sales-page__body {
  width: min(100%, 820px); margin: 0 auto; padding: clamp(126px, 11vw, 156px) 28px 112px;
}
.public-sales-page[data-layout="article"] .public-sales-page__eyebrow {
  display: inline-flex; align-items: center; margin: 0 0 22px; padding: 7px 12px;
  border: 1px solid color-mix(in srgb, var(--sales-accent, #008652) 22%, transparent);
  border-radius: 999px; background: color-mix(in srgb, var(--sales-accent, #008652) 7%, white);
  color: var(--sales-accent, #008652); font-size: .8rem; font-weight: 700;
  letter-spacing: .02em; line-height: 1.2;
}
.public-sales-page[data-layout="article"] h1 {
  margin: 0 0 30px; max-width: 18ch; font-size: clamp(2.7rem, 6vw, 4.3rem);
  line-height: 1.12; font-weight: 720;
}
.public-sales-page[data-layout="article"] .public-sales-page__story {
  max-width: 72ch; font-size: 1.08rem; line-height: 1.82;
}
.public-sales-page[data-layout="article"] .public-sales-page__inline-checkout {
  margin-top: clamp(48px, 8vw, 76px); padding: 0;
  border: 0; border-radius: 0; background: transparent;
  scroll-margin-top: 24px;
}
.public-sales-page[data-layout="article"] .public-sales-page__inline-checkout > h2 {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
.public-sales-page[data-layout="article"] .public-sales-page__inline-checkout > p {
  display: none;
}
.public-sales-page[data-layout="article"] .public-sales-page__story p { margin: 0 0 1.35em; }
.public-sales-page[data-layout="article"] .public-sales-page__story > p:first-child {
  font-size: 1.22rem; line-height: 1.65; color: color-mix(in srgb, var(--sales-text, #26333b) 78%, white);
  margin-bottom: 2.4em;
}
.public-sales-page[data-layout="article"] .public-sales-page__section-heading {
  margin: 2.7em 0 .72em; font-size: clamp(1.35rem, 3vw, 1.8rem);
  line-height: 1.28; font-weight: 720;
}
.public-sales-page[data-layout="article"] .public-sales-page__story > p:has(> a > strong) {
  border: 1px solid color-mix(in srgb, var(--sales-text, #0f172a) 15%, transparent);
  border-radius: 13px; background: color-mix(in srgb, var(--sales-accent, #008652) 3%, white);
  margin: 1.3em 0 .45em; padding: 1em 1.1em; font-size: 1.16rem; line-height: 1.35;
}
.public-sales-page[data-layout="article"] .public-sales-page__story > p:has(> a > strong) a { text-decoration: none; }
.public-sales-page[data-layout="article"] .public-sales-page__story > p:has(> a > strong) + p { color: color-mix(in srgb, var(--sales-text, #26333b) 76%, white); }
.public-sales-page[data-layout="article"] .public-sales-page__story > p:has(> a[href="/#pricing"] > strong),
.public-sales-page[data-layout="article"] .public-sales-page__story > p:has(> a[href="#membership-checkout"] > strong) {
  display: inline-flex; border-color: var(--sales-accent, #008652);
  background: var(--sales-accent, #008652); color: #fff;
}
.public-sales-page[data-layout="article"] .public-sales-page__story > p:has(> a[href="/#pricing"] > strong) a,
.public-sales-page[data-layout="article"] .public-sales-page__story > p:has(> a[href="#membership-checkout"] > strong) a { color: #fff; }
.public-sales-page[data-layout="article"] .public-sales-page__story > .public-sales-page__section-heading:last-of-type + p {
  padding: 1em 1.15em; border-left: 3px solid var(--sales-accent, #008652);
  border-radius: 0 9px 9px 0; background: color-mix(in srgb, var(--sales-accent, #008652) 5%, white);
}
.public-sales-page[data-layout="article"] .source-citation { display: inline-flex; position: relative; vertical-align: baseline; margin: 0 .12em; }
.public-sales-page[data-layout="article"] .source-citation__toggle { position: absolute; width: 1px; height: 1px; opacity: 0; }
.public-sales-page[data-layout="article"] .source-citation__trigger {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px;
  border: 1px solid color-mix(in srgb, var(--sales-accent, #008652) 30%, transparent);
  border-radius: 999px; background: color-mix(in srgb, var(--sales-accent, #008652) 8%, white);
  color: var(--sales-accent, #008652); cursor: pointer; font-family: inherit; font-size: .69em; font-weight: 700; line-height: 1.3;
  vertical-align: .12em; transition: background-color .16s ease, border-color .16s ease, box-shadow .16s ease;
}
.public-sales-page[data-layout="article"] .source-citation__trigger:hover { background: color-mix(in srgb, var(--sales-accent, #008652) 14%, white); border-color: var(--sales-accent, #008652); }
.public-sales-page[data-layout="article"] .source-citation__toggle:focus-visible + .source-citation__trigger { outline: 3px solid var(--sales-accent, #008652); outline-offset: 3px; }
.public-sales-page[data-layout="article"] .source-citation__panel {
  display: none; position: absolute; left: 0; bottom: calc(100% - 4px); z-index: 50;
  box-sizing: border-box; width: min(360px, calc(100vw - 32px)); max-height: min(70vh, 520px); overflow-y: auto; padding: 48px 18px 18px;
  border: 1px solid color-mix(in srgb, var(--sales-text, #0f172a) 12%, white);
  border-radius: 16px; background: #fff; box-shadow: 0 20px 56px rgba(15,23,42,.2), 0 3px 10px rgba(15,23,42,.08);
  color: var(--sales-text, #0f172a); font-size: .84rem; line-height: 1.55; text-align: left;
}
.public-sales-page[data-layout="article"] .source-citation__panel::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -20px; height: 20px;
}
.public-sales-page[data-layout="article"] .source-citation:not([data-citation-dismissed="true"]) .source-citation__toggle:checked ~ .source-citation__panel,
.public-sales-page[data-layout="article"] .source-citation:not([data-citation-dismissed="true"]):has(.source-citation__toggle:focus-visible) > .source-citation__panel,
.public-sales-page[data-layout="article"] .source-citation:not([data-citation-dismissed="true"]):has(.source-citation__panel :focus) > .source-citation__panel { display: flex; flex-direction: column; gap: 7px; }
.public-sales-page[data-layout="article"] .source-citation__close {
  position: absolute; top: 6px; right: 6px; display: inline-flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; border: 0;
  padding: 8px; border-radius: 8px; background: transparent; color: #64748b; cursor: pointer;
  font: inherit;
}
.public-sales-page[data-layout="article"] .source-citation__close:hover { background: rgba(239,68,68,.1); color: #dc2626; }
.public-sales-page[data-layout="article"] .source-citation__close:focus-visible { outline: 3px solid var(--sales-accent, #008652); outline-offset: 2px; }
.public-sales-page[data-layout="article"] .source-citation__thumbnail { display: block; width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 10px; background: #e9ece8; }
.public-sales-page[data-layout="article"] .source-citation__player { display: block; position: relative; width: 100%; overflow: hidden; border-radius: 10px; background: #111; }
.public-sales-page[data-layout="article"] .source-citation__preview { display: block; width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 0; background: #111; }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] {
  position: absolute; inset: auto 0 0; z-index: 2; box-sizing: border-box; padding: 24px 10px 8px;
  background: linear-gradient(transparent, rgba(0,0,0,.9)); color: #fff;
}
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] > div {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] > div:first-child { margin-bottom: 3px; }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] > div > div { display: flex; align-items: center; gap: 4px; }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] [role="slider"] { position: relative; display: flex; align-items: center; width: 58px; height: 16px; cursor: pointer; }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] [aria-label="Seek"] { flex: 1; width: auto; }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] [role="slider"] > div:first-child { width: 100%; height: 4px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.36); }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] [role="slider"] > div:first-child > div { height: 100%; background: #fff; }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] [role="slider"] > div:last-child { position: absolute; width: 10px; height: 10px; border-radius: 50%; background: #fff; }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] span { color: #fff; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 4px; border: 0; border-radius: 7px; background: transparent; color: #fff; cursor: pointer; }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] button:hover,
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] button:focus-visible { background: rgba(255,255,255,.22); outline: 2px solid #fff; outline-offset: 1px; }
.public-sales-page[data-layout="article"] .source-citation__player [data-ui-part="playback-controls"] button svg { width: 18px; height: 18px; }
.public-sales-page[data-layout="article"] .source-citation__preview-note { color: color-mix(in srgb, var(--sales-text, #0f172a) 62%, white); font-size: .72rem; font-weight: 650; }
.public-sales-page[data-layout="article"] .source-citation__label { color: var(--sales-accent, #008652); font-size: .68rem; font-weight: 750; text-transform: uppercase; letter-spacing: .08em; }
.public-sales-page[data-layout="article"] .source-citation__title { font-size: 1.03rem; line-height: 1.28; letter-spacing: -.01em; }
.public-sales-page[data-layout="article"] .source-citation__excerpt { color: color-mix(in srgb, var(--sales-text, #0f172a) 78%, white); }
.public-sales-page[data-layout="article"] .source-citation__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 7px; font-weight: 700; }
.public-sales-page[data-layout="article"] .source-citation__actions a { display: inline-flex; align-items: center; min-height: 36px; padding: 0 12px; border-radius: 999px; background: color-mix(in srgb, var(--sales-accent, #008652) 9%, white); color: var(--sales-accent, #008652); text-decoration: none; }
.public-sales-page[data-layout="article"] .source-citation__actions a:hover,
.public-sales-page[data-layout="article"] .source-citation__actions a:focus-visible { background: color-mix(in srgb, var(--sales-accent, #008652) 16%, white); text-decoration: underline; }
@media (hover: hover) and (pointer: fine) {
  .public-sales-page[data-layout="article"] .source-citation:not([data-citation-dismissed="true"]):hover > .source-citation__panel { display: flex; flex-direction: column; gap: 7px; }
}
@media (max-width: 620px) {
  .public-sales-page[data-layout="article"] .public-sales-page__body { padding: 120px 12px 80px; }
  .public-sales-page[data-layout="article"] .public-sales-page__story { font-size: 1rem; line-height: 1.75; }
  .public-sales-page[data-layout="article"] .public-sales-page__inline-checkout {
    padding: 0; border: 0; border-radius: 0; background: transparent;
  }
  .public-sales-page[data-layout="article"] .source-citation__panel {
    position: fixed; inset: auto 12px 12px; width: auto; max-height: min(72vh, 560px); overflow-y: auto;
    padding: 52px 18px 18px; border-radius: 18px; box-shadow: 0 24px 70px rgba(15,23,42,.28);
  }
  .public-sales-page[data-layout="article"] .source-citation__close { width: 44px; height: 44px; top: 6px; right: 6px; padding: 12px; }
}
`;
