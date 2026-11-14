# linked-identity

One small mark that names something outside the app (a platform, an account, a person) and opens it beside the work.

| File | Purpose |
|------|---------|
| `LinkedIdentity.tsx` | The mark: image, provider logo or initials; shared Tooltip with the name and an up-right open cue; opens a placeable web-frame pane. |
| `LinkedIdentity.test.tsx` | Registry-resolved profile link opens in a placeable pane; initials without an address; unsafe addresses never open. |
| `index.ts` | Barrel. |

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `LinkedIdentity` | `(LinkedIdentityOptions) => JSX` | Draws and opens one identity. |
| `LinkedIdentityOptions` | `{label, detail?, mark?: 'provider'\|'avatar', providerSlug?, imageUrl?, href?, handle?, registry?}` | `href` wins; otherwise `handle` resolves through the provider row's `profile_link` DATA. |
| `openLinkedIdentity` | `(title, href) => boolean` | Emits the web-frame placeable surface intent for a safe address. |
| `safeLinkedIdentityUrl` | `(value) => string` | https/http without credentials, else `''`. |

Appearance lives in `screen-look/show/coss-workspace.css` (`linked-identity*`, `--link-hover-color`).

**Depends on:** `tooltip`, `provider-mark` (`ProviderMark`, `providerProfileUrl`), `placeable-surface-intent`, `coss/ui` Avatar and Button.
**Depended on by:** `coss/workspace-controls.tsx` (`linkedIdentityContent`, `mountLinkedIdentity`), Expansion Schedule (`media-workspace/schedule-destination.mjs`).
