// parts/service-connections/do-work/engine-seams.ts
//
// The connect functions take a `seams` argument (connect-service.ts `ServiceConnectionSeams`): where the work
// contract, the value store, the owner actions and the clock come from. Trillion always passes its own
// (src/held-values.mjs), so a call that passes none has nowhere to go and says so instead of guessing.

import type { ServiceConnectionSeams } from './connect-service';

export function engineSeams(_context?: unknown): ServiceConnectionSeams {
  throw new Error('No seams were passed to the connect call. Pass the host\'s own seams (see src/held-values.mjs).');
}
