// packages/screen-arrangement/do-work/decoration-bytes-namespace.ts
//
// Screen-arrangement's own CAS namespace for region decoration media (B3). The
// generic `store-bytes-to-cas` store is domain-neutral; this is the ONE place
// screen-arrangement's decoration-bytes address convention lives, passed to the
// generic store by every decoration caller (the add-layer picker + the drop
// router) so the Society address string is defined once, not per call site.

import type { CasNamespace } from '@/packages/screen-arrangement/do-work/store-bytes-to-cas'

export const DECORATION_BYTES_NAMESPACE: CasNamespace = {
  partitionLabel: 'runtime-partition',
  addressPrefix: 'package::screen-arrangement::decoration-bytes',
  pathLabels: ['screen-arrangement', 'decoration-bytes'],
}
