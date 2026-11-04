// Shared nested navigation appearance; the UI owner inserts this stylesheet with its component.
export const nestedNavigationClasses = {
  root: 'bf-nested-navigation-root',
  branch: 'bf-nested-navigation-branch',
  branchButton: 'bf-nested-navigation-branchButton',
  item: 'bf-nested-navigation-item',
  branchName: 'bf-nested-navigation-branchName',
  count: 'bf-nested-navigation-count',
  children: 'bf-nested-navigation-children',
  empty: 'bf-nested-navigation-empty',
  picker: 'bf-nested-navigation-picker',
  pickerText: 'bf-nested-navigation-pickerText',
  pickerHint: 'bf-nested-navigation-pickerHint',
  pickerTitle: 'bf-nested-navigation-pickerTitle',
} as const;

export const nestedNavigationStyle = `
.bf-nested-navigation-root {
  display: grid;
  gap: 0.3rem;
  min-width: 0;
  color: var(--text-primary, #f4f2ee);
}
.bf-nested-navigation-branch { min-width: 0; }
.bf-nested-navigation-branchButton, .bf-nested-navigation-item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  min-height: 2.75rem;
  border: 0;
  border-radius: 0.65rem;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.bf-nested-navigation-branchButton {
  padding: 0.45rem 0.7rem;
  color: var(--text-secondary, #d0d0cb);
  font-size: 0.82rem;
  font-weight: 720;
  letter-spacing: 0.025em;
}
.bf-nested-navigation-branchButton:hover, .bf-nested-navigation-item:hover:not(:disabled) { background: color-mix(in srgb, var(--text-primary, white) 8%, transparent); }
.bf-nested-navigation-branchButton:focus-visible, .bf-nested-navigation-item:focus-visible { outline: 2px solid var(--border-focus, #80baff); outline-offset: 2px; }
.bf-nested-navigation-branchName { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.bf-nested-navigation-count {
  flex: none;
  min-width: 1.6rem;
  padding: 0.15rem 0.4rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-primary, white) 8%, transparent);
  color: var(--text-muted, #a9aba8);
  font-size: 0.68rem;
  text-align: center;
}
.bf-nested-navigation-children {
  display: grid;
  gap: 0.12rem;
  margin: 0.12rem 0 0.42rem 0.98rem;
  padding-left: 0.78rem;
}
.bf-nested-navigation-item {
  padding: 0.5rem 0.75rem;
  font-size: 0.88rem;
  font-weight: 530;
  line-height: 1.35;
}
.bf-nested-navigation-item > span { min-width: 0; overflow-wrap: anywhere; }
.bf-nested-navigation-item svg { flex: none; color: var(--text-muted, #a9aba8); }
.bf-nested-navigation-item[aria-current='page'] {
  background: color-mix(in srgb, var(--border-focus, #80baff) 19%, transparent);
  color: var(--text-strong, white);
  font-weight: 680;
}
.bf-nested-navigation-item[aria-current='page'] svg { color: var(--border-focus, #80baff); }
.bf-nested-navigation-item:disabled { cursor: not-allowed; opacity: 0.48; }
.bf-nested-navigation-empty { padding: 1.25rem 0.75rem; color: var(--text-muted, #a9aba8); font-size: 0.88rem; }
.bf-nested-navigation-picker {
  display: flex !important;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  min-height: 3.8rem !important;
  padding: 0.65rem 0.85rem !important;
  text-align: left;
  border-radius: 0.8rem !important;
}
.bf-nested-navigation-pickerText { display: grid; flex: 1; min-width: 0; gap: 0.08rem; }
.bf-nested-navigation-pickerHint { font-size: 0.66rem; font-weight: 720; color: var(--text-muted, #a9aba8); }
.bf-nested-navigation-pickerTitle { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 0.88rem; font-weight: 650; }

`;
