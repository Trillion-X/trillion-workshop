# Focus Overlay

Browser-local maximized-pane frame used by screen arrangement focus mode.

The backdrop is a token-dimmed dismissal target using
`--glass-overlay-background`. It must not use `backdrop-filter`; large fixed
backdrop-filter layers render as dark horizontal bands in Safari. The focused
pane uses the shared `glass-surface` primitive so maximized containers keep the
same screen-look glass surface as arranged containers while the background is
visually separated.
