# Read Data

`tools/browse-and-publish-what-my-ai-can-use/packages/bitfield-package-store-offer-exchange/read-data/read-record-exchange-projection.ts` is the pure reader for Record Exchange
Projection. It reads descriptor and fact arrays, evaluates open rule methods, and
returns display-ready rows plus action availability. Rule state labels and tones
come from descriptor params; the reader does not invent package-store statuses.

The reader owns no effect. Side effects leave this package as owner-action
intent data from `do-work/`.
