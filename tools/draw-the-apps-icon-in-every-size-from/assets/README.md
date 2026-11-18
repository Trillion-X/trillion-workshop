# assets

Pictures and media the Worker (`src/worker.mjs`) imports and serves: Trillion's icons at every size a browser, phone or share sheet asks for, plus media used on public pages.

## Files

| File | Purpose |
|------|---------|
| `icon.png` | The large Trillion icon, served at `/icon.png` and listed in `server.json` for AI apps and directories. |
| `icon-48.png` | The small listing icon, `/icon-48.png`. |
| `icon-192.png`, `icon-512.png` | Installed web app icons (`purpose: any` in `/trillion.webmanifest`): white needle and red thread on pure `#000000`, the thread running off the right edge. The 512 px square is the link-preview image on public share pages. |
| `icon-maskable-512.png` | The installed web app's Android maskable icon (`purpose: maskable`): same art with the needle inside the 80% safe circle, so a round or squircle mask never cuts it. |
| `apple-touch-icon.png` | 180 px icon iOS uses when the site is added to a Home Screen, served at `/apple-touch-icon.png`. |
| `favicon.svg` | The one drawing of Trillion's mark: the white needle and red thread on pure `#000000` filling the whole square. Served at `/favicon.svg` for browser tabs and listed first in `server.json`. The needle stands a little left of centre at 60% of the height and the thread runs off the right edge. `scripts/make-icon.mjs` renders every icon file from it, each in one framing from its `FRAMINGS` DATA (full; maskable, zoomed out 1.25 so the needle sits inside the 80% safe circle; small, zoomed in with strokes thickened about half a pixel for 16 to 48 px; tinted, grey on clear for iOS): `favicon.ico` (16/32/48), `icon-48.png`, `icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, the extension's `extension/icons/`, the iPhone's `AppIcon` PNGs, and the site's copies, and the Mac's chooseable Dock icon (`macos/App/AppIcons/AppIconWhite.png`, from the supplied `brand/mark-black-white.svg`). |
| `favicon.ico` | Browser tab icon at 16, 32 and 48 px, rendered from `favicon.svg`. |
| `brand/` | The SVG and PNG full wordmark and mark variants supplied in `dev/trillion-branding`. Their live selection and URLs are rows in the operator's Brand assets list. `/brand/current/wordmark.svg`, `/brand/current/wordmark.png`, and the current mark read that list and the worn Screen look. The old `/brand/trillion-wordmark.svg` address redirects to the current asset. |
| `stories-share.png` | Picture used when a page is shared as a story. |
| `chatgpt-demo.mp4` | Demo video on public pages. |
| `illustrations/` | Drawings and pictures server pages show, served under `/workspace/illustrations/` by `scripts/build-workspace.mjs`: each page's opening drawing (`sign-in`, `add-passkey`, `link-expired`, `not-found`, `something-broke`) and the four pictures of the welcome after paying from the Chrome extension (`extension-step-go-back`, `extension-step-refresh`, `extension-step-toolbar-button`, `extension-step-save-send`: a Chrome window with the part to press circled, named by `src/checkout-welcome.json`), and `iphone-share-*.webp`, one per step of the Share to Trillion from your iPhone tour (`src/workspace/walkthroughs/iphone-share.json`), each a Simulator screenshot of the real Share sheet with what to tap ringed in red (`ios/ProofTests/ShareSetupProof.swift`). |

## Key Types / Functions

None: every file is bytes the Worker imports as a module and returns with its content type.

## Dependencies

**Depends on:** nothing.
**Depended on by:** `src/worker.mjs` (public logo, icon and favicon routes), `src/phone-share.mjs` (`phoneShareManifest.icons`). The browser extension carries its own `extension/icons/`.
