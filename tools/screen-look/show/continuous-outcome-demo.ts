export const CONTINUOUS_OUTCOME_DEMO_CSS = String.raw`
  #continuous-outcome-demo-host .continuous-outcome-demo {
    --demo-accent: #7c5cff;
    --demo-green: #169b62;
    --demo-red: #d20f32;
    --demo-surface: color-mix(in srgb, var(--surface-base, #f5f5f5) 92%, white);
    --demo-panel: color-mix(in srgb, var(--surface-base, #f5f5f5) 97%, var(--text-primary, #15151a));
    --demo-border: color-mix(in srgb, var(--text-primary, #15151a) 13%, transparent);
    box-sizing: border-box;
    width: min(1080px, calc(100% - 40px));
    max-width: 1080px;
    margin: clamp(58px, 9vw, 124px) auto clamp(90px, 13vw, 168px);
    color: var(--text-primary, #15151a);
    pointer-events: auto;
  }

  .continuous-outcome-demo__intro {
    max-width: 840px;
    margin: 0 auto clamp(34px, 5vw, 62px);
    text-align: center;
  }

  .continuous-outcome-demo__intro h2 {
    margin: 0;
    font-family: var(--font-display, ui-serif, Georgia, serif);
    font-size: clamp(2rem, 4vw, 4.4rem);
    font-weight: 740;
    letter-spacing: -0.018em;
    line-height: 1.08;
    text-wrap: balance;
  }

  .continuous-outcome-demo__intro p {
    max-width: 680px;
    margin: 22px auto 0;
    color: var(--text-secondary, #5f6672);
    font-size: clamp(1rem, .5vw + .9rem, 1.2rem);
    line-height: 1.62;
    text-wrap: balance;
  }

  .continuous-outcome-demo__window {
    overflow: hidden;
    border: 1px solid var(--demo-border);
    border-radius: 22px;
    background: var(--demo-surface);
    box-shadow: 0 36px 96px -68px color-mix(in srgb, var(--text-primary, #15151a) 72%, transparent);
  }

  .continuous-outcome-demo__chrome {
    min-height: 52px;
    padding: 0 17px;
    border-bottom: 1px solid var(--demo-border);
    background: color-mix(in srgb, var(--demo-panel) 90%, transparent);
  }

  .continuous-outcome-demo__lights {
    display: grid;
    grid-template-columns: repeat(3, 8px);
    gap: 6px;
  }

  .continuous-outcome-demo__light {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--text-secondary, #7a8494);
    opacity: .32;
  }

  .continuous-outcome-demo__light:first-child { background: #e55b5b; opacity: .95; }
  .continuous-outcome-demo__light:nth-child(2) { background: #f1b83a; opacity: .95; }
  .continuous-outcome-demo__light:nth-child(3) { background: #35be7a; opacity: .95; }

  .continuous-outcome-demo__live {
    color: var(--demo-accent);
    font-size: .72rem;
    font-weight: 800;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  .continuous-outcome-demo__workspace {
    display: grid;
    grid-template-columns: minmax(210px, .72fr) minmax(0, 2.35fr);
    min-height: 680px;
  }

  .continuous-outcome-demo__context {
    padding: 18px;
    border-right: 1px solid var(--demo-border);
    background: color-mix(in srgb, var(--demo-panel) 84%, transparent);
  }

  .continuous-outcome-demo__eyebrow {
    color: var(--text-secondary, #687180);
    font-size: .67rem;
    font-weight: 820;
    letter-spacing: .1em;
    text-transform: uppercase;
  }

  .continuous-outcome-demo__goal {
    margin-top: 10px;
    font-family: var(--font-display, ui-serif, Georgia, serif);
    font-size: 1.12rem;
    font-weight: 730;
    line-height: 1.22;
  }

  .continuous-outcome-demo__source-list { margin-top: 20px; }

  .continuous-outcome-demo__source {
    min-height: 48px;
    padding: 9px 10px;
    border: 1px solid transparent;
    border-radius: 11px;
    transition: border-color 180ms ease, background 180ms ease, transform 180ms ease;
  }

  .continuous-outcome-demo__source[data-live='true'] {
    border-color: color-mix(in srgb, var(--demo-accent) 55%, var(--demo-border));
    background: color-mix(in srgb, var(--demo-accent) 8%, var(--demo-panel));
    transform: translateX(3px);
  }

  .continuous-outcome-demo__source-dot {
    display: grid;
    width: 25px;
    height: 25px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 8px;
    color: white;
    background: var(--demo-accent);
    font-size: .64rem;
    font-weight: 860;
  }

  .continuous-outcome-demo__source strong,
  .continuous-outcome-demo__source small { display: block; }
  .continuous-outcome-demo__source strong { font-size: .76rem; }
  .continuous-outcome-demo__source small { margin-top: 2px; color: var(--text-secondary, #687180); font-size: .64rem; line-height: 1.25; }

  .continuous-outcome-demo__run { min-width: 0; padding: 18px; }

  .continuous-outcome-demo__stages {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 7px;
    margin: 14px 0 18px;
  }

  .continuous-outcome-demo__stage {
    min-width: 0;
    padding: 8px 5px;
    border: 1px solid var(--demo-border);
    border-radius: 10px;
    color: var(--text-secondary, #687180);
    background: transparent;
    font-size: .63rem;
    font-weight: 760;
    line-height: 1.15;
    text-align: center;
    transition: color 180ms ease, border-color 180ms ease, background 180ms ease, transform 180ms ease;
  }

  .continuous-outcome-demo__stage[data-current='true'] {
    border-color: var(--demo-accent);
    color: var(--text-primary, #15151a);
    background: color-mix(in srgb, var(--demo-accent) 10%, var(--demo-panel));
    transform: translateY(-2px);
  }

  .continuous-outcome-demo__stage[data-complete='true']::before {
    content: '✓';
    margin-right: 4px;
    color: var(--demo-green);
  }

  .continuous-outcome-demo__canvas {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(220px, .82fr);
    gap: 12px;
  }

  .continuous-outcome-demo__main-card,
  .continuous-outcome-demo__side-card {
    min-width: 0;
    border: 1px solid var(--demo-border);
    background: var(--demo-panel);
  }

  .continuous-outcome-demo__main-card { min-height: 468px; }
  .continuous-outcome-demo__side-card { min-height: 220px; }

  .continuous-outcome-demo__decision {
    padding: 18px;
    border-radius: 13px;
    color: white;
    background: linear-gradient(138deg, #17122d, #2d1f60 64%, #402986);
  }

  .continuous-outcome-demo__decision h3 {
    margin: 7px 0 0;
    color: white;
    font-family: var(--font-display, ui-serif, Georgia, serif);
    font-size: clamp(1.25rem, 1.4vw, 1.7rem);
    line-height: 1.12;
  }

  .continuous-outcome-demo__decision .continuous-outcome-demo__eyebrow {
    color: rgb(255 255 255 / .68);
  }

  .continuous-outcome-demo__principles,
  .continuous-outcome-demo__capabilities,
  .continuous-outcome-demo__plugins,
  .continuous-outcome-demo__actions,
  .continuous-outcome-demo__results { margin-top: 14px; }

  .continuous-outcome-demo__principles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .continuous-outcome-demo__plugins { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .continuous-outcome-demo__results { grid-template-columns: repeat(3, minmax(0, 1fr)); }

  .continuous-outcome-demo__principle {
    padding: 9px 10px;
    border: 1px solid var(--demo-border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--demo-panel) 92%, var(--demo-accent));
  }

  .continuous-outcome-demo__principle strong { display: block; font-size: .72rem; }
  .continuous-outcome-demo__principle small { display: block; margin-top: 3px; color: var(--text-secondary, #687180); font-size: .64rem; line-height: 1.3; }

  .continuous-outcome-demo__capability-rail {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 5px;
    margin-top: 9px;
  }

  .continuous-outcome-demo__capability {
    min-width: 0;
    min-height: 34px;
    padding: 5px 7px;
    border: 1px solid var(--demo-border);
    border-radius: 9px;
    color: var(--text-secondary, #687180);
    background: color-mix(in srgb, var(--demo-panel) 96%, var(--text-primary, #15151a));
  }

  .continuous-outcome-demo__capability[data-on='true'] {
    border-color: var(--demo-accent);
    color: var(--text-primary, #15151a);
    background: color-mix(in srgb, var(--demo-accent) 12%, var(--demo-panel));
  }

  .continuous-outcome-demo__capability-number {
    display: grid;
    width: 20px;
    height: 20px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 999px;
    color: var(--text-secondary, #687180);
    background: color-mix(in srgb, var(--text-primary, #15151a) 8%, transparent);
    font-size: .58rem;
    font-weight: 850;
  }

  .continuous-outcome-demo__capability[data-on='true'] .continuous-outcome-demo__capability-number {
    color: white;
    background: var(--demo-accent);
  }

  .continuous-outcome-demo__capability-name {
    min-width: 0;
    color: inherit;
    font-size: .63rem;
    font-weight: 720;
    line-height: 1.18;
  }

  .continuous-outcome-demo__plugin,
  .continuous-outcome-demo__action,
  .continuous-outcome-demo__result {
    min-height: 46px;
    padding: 9px 10px;
    border: 1px solid var(--demo-border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--demo-panel) 94%, var(--text-primary, #15151a));
  }

  .continuous-outcome-demo__plugin strong,
  .continuous-outcome-demo__action strong,
  .continuous-outcome-demo__result strong { font-size: .72rem; }

  .continuous-outcome-demo__plugin small,
  .continuous-outcome-demo__action small,
  .continuous-outcome-demo__result small { color: var(--text-secondary, #687180); font-size: .63rem; }

  .continuous-outcome-demo__verb {
    color: var(--demo-accent);
    font-size: .6rem;
    font-weight: 850;
    letter-spacing: .07em;
    text-transform: uppercase;
  }

  .continuous-outcome-demo__network {
    position: relative;
    min-height: 196px;
    overflow: hidden;
    border-radius: 12px;
    background:
      radial-gradient(circle at 50% 46%, color-mix(in srgb, var(--demo-green) 18%, transparent), transparent 35%),
      linear-gradient(145deg, color-mix(in srgb, var(--demo-panel) 92%, var(--demo-green)), var(--demo-panel));
  }

  .continuous-outcome-demo__network::before,
  .continuous-outcome-demo__network::after {
    content: '';
    position: absolute;
    inset: 50% auto auto 50%;
    width: 72%;
    height: 1px;
    background: color-mix(in srgb, var(--demo-green) 48%, transparent);
    transform-origin: left center;
    transform: rotate(-24deg);
  }

  .continuous-outcome-demo__network::after { transform: rotate(25deg); }

  .continuous-outcome-demo__person {
    position: relative;
    z-index: 1;
    width: 72px;
    height: 72px;
    border: 2px solid var(--demo-green);
    border-radius: 999px;
    background: var(--demo-panel);
    box-shadow: 0 0 0 9px color-mix(in srgb, var(--demo-green) 10%, transparent);
  }

  .continuous-outcome-demo__person strong { color: var(--demo-green); font-size: 1rem; }

  .continuous-outcome-demo__outcome {
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--demo-green) 50%, var(--demo-border));
    border-radius: 12px;
    background: color-mix(in srgb, var(--demo-green) 8%, var(--demo-panel));
  }

  .continuous-outcome-demo__metric { color: var(--demo-green); font-size: 1.42rem; font-weight: 850; }

  .continuous-outcome-demo__footer {
    min-height: 52px;
    padding: 11px 16px;
    border-top: 1px solid var(--demo-border);
    background: color-mix(in srgb, var(--demo-panel) 88%, transparent);
  }

  .continuous-outcome-demo__footer strong { font-size: .78rem; }
  .continuous-outcome-demo__footer span { color: var(--text-secondary, #687180); font-size: .7rem; }

  @media (max-width: 820px) {
    #continuous-outcome-demo-host .continuous-outcome-demo { width: calc(100vw - 24px); max-width: 680px; }
    .continuous-outcome-demo__workspace { grid-template-columns: 1fr; }
    .continuous-outcome-demo__context { border-right: 0; border-bottom: 1px solid var(--demo-border); }
    .continuous-outcome-demo__source-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
    .continuous-outcome-demo__canvas { grid-template-columns: 1fr; }
    .continuous-outcome-demo__main-card { min-height: auto; }
    .continuous-outcome-demo__stages { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }

  @media (max-width: 480px) {
    .continuous-outcome-demo__chrome { padding: 0 12px; }
    .continuous-outcome-demo__chrome-title { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .continuous-outcome-demo__context,
    .continuous-outcome-demo__run { padding: 12px; }
    .continuous-outcome-demo__source-list { grid-template-columns: 1fr; }
    .continuous-outcome-demo__stages { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .continuous-outcome-demo__principles { grid-template-columns: 1fr !important; }
    .continuous-outcome-demo__plugins { grid-template-columns: 1fr !important; }
    .continuous-outcome-demo__results { grid-template-columns: 1fr; }
    .continuous-outcome-demo__capability-rail { grid-template-columns: 1fr; gap: 4px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .continuous-outcome-demo *,
    .continuous-outcome-demo *::before,
    .continuous-outcome-demo *::after { transition: none !important; animation: none !important; }
  }
`;
