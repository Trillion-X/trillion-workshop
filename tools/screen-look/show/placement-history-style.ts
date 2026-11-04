/** Appearance for the shared saved and recent choice menu. */
export const PLACEMENT_HISTORY_STYLE = `
.bf-placement-history-list { position: relative; }
.bf-placement-history-list::before, .bf-placement-history-list::after {
  content: ''; position: absolute; left: 0; right: 0; height: 10px; z-index: 2;
  pointer-events: none;
}
.bf-placement-history-list::before { top: 0; background: linear-gradient(to bottom, var(--glass-popover-background, var(--glass-bg-active, #171717)), transparent); }
.bf-placement-history-list::after { bottom: 0; background: linear-gradient(to top, var(--glass-popover-background, var(--glass-bg-active, #171717)), transparent); }
@media (forced-colors: active), (prefers-reduced-transparency: reduce) {
  .bf-placement-history-list::before, .bf-placement-history-list::after { display: none; }
}
`;
