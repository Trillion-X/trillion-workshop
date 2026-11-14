# Account Session UI

Reusable login and authenticated-surface gate for account-session state.

- `presentation: "page"` preserves the standalone account login page.
- `presentation: "embedded"` supplies only the form so a caller can own its dialog.
- `presentation: "modal"` shows a sanitized, inert learning-shaped preview behind
  the canonical modal. The DATA-addressed `protected_surface` is not mounted at
  all while anonymous, so lesson bodies and resource URLs cannot leak through DOM
  inspection. It mounts only after the current browser session is valid.
- Session focus/visibility changes and the canonical session-authority expiry
  trigger a fresh owner read. There is no presentation-owned polling loop.

`protected_surface`, request TARGETs, redirect paths, and copy remain DATA; the
generic package contains no tenant or course identity.
