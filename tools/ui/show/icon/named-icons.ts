// parts/ui/show/icon/named-icons.ts
//
// Every Lucide icon, by name, for the shared resolver (NamedIcon.tsx). A browser bundle never carries this file: its
// build replaces the module with only the icons the repository names (scripts/named-icons.mjs), so a page ships the
// icons it can show and a caller that was never built (a node test, a script) still resolves every name.

import * as lucide from 'lucide-react';

export default lucide as Record<string, unknown>;
/** The icons a browser bundle sends after its first load (scripts/named-icons.mjs); here every icon is already above. */
export const rest = async (): Promise<Record<string, unknown>> => ({});
