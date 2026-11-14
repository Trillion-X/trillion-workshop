# Publication workspace

`mountPublicationWorkspace` is the reusable compact composer frame: a
platform → linked account → supported publishing format tree, a focused
in-place stage rail, a shared-content panel and a persistent action rail. It
accepts provider-neutral records and callbacks; it has no platform OAuth or
product routing knowledge.

Pass only records whose current service-connection state is ready and which
represent a publishing destination. Use the concrete connection identity to
group formats beneath the account that owns them, and use each destination ID
unchanged in `onDestination`. `accountLabel` and `serviceConnectionRef` must
come from the live service-connections state. Unlinked options are hidden; the
picker does not invent connected accounts or offer messaging endpoints as post
formats. A destination can supply its own `content` node so each account and
format keeps its own editable values when selected.

Platform marks use the shared `ProviderMark` resolver. Pass the current
`provider-icon-registry-feed` rows through `providerIconRegistry` when the
service-connections owner supplies them; otherwise the shared package's shipped
provider-icon DATA is used. Provider slugs select marks by identity, so adding a
provider icon requires DATA rather than a platform-specific rendering branch.
Unknown identities use the shared monogram fallback.

## Instagram publishing formats

The picker renders the formats supplied by each ready destination row; it does
not maintain a platform-specific format list. Meta's official content
publishing guide, checked 2026-09-22, documents single images, videos, Reels,
carousel posts and Story posts for Instagram professional accounts. It also
documents a 10-item carousel maximum in its carousel section. The connection
and destination records remain the authority for which of those formats are
available to a particular linked account. Do not infer Story, carousel, or
other publishing support from an Instagram login alone.

Source: [Meta Instagram Platform — Content Publishing](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing/), accessed 2026-09-22.

## Reference disposition

- Postiz `new-launch/add.edit.modal.tsx` and `launches/helpers/pick.platform.component.tsx` were inspected for interaction anatomy only. Postiz is AGPL-3.0, so no Postiz source, styles, strings, or assets are copied.
- Interactive components are the already pinned MIT Coss `Button`, `Badge`, and `Card` sources, recorded in `provenance.json`.
- The layout is a behavioural adaptation: select destinations at the work, switch focused edit/review stages without a stacked modal, and keep save/publish actions visible.

The consuming feature must put real metadata controls inside `content` using
shared UI owners. It must not create raw interactive HTML or another modal.
