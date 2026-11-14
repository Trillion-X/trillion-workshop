// P-ROUTE — anonymous entry-surface resolution (GP7 anonymous reachability).
//
// The boot scene mounts exactly one component (screen-after-sign-in-check). For an
// anonymous visitor that component is the entry router: it must NOT gate cold traffic
// behind a sign-up wall. WHICH surface(s) an anonymous visitor sees is a pure function
// of the route.
//
// This resolution is DATA-driven (L090 / enum-dissolution). A route maps to an
// AnonEntryPlan = { primary, companions[] }:
//   - `primary`   — the surface the visitor sees (present the product / transact / auth).
//   - `companions`— headless surfaces that mount alongside it for their on-mount effect
//                   (e.g. a traffic-capture beacon). Cross-cutting per-visit behaviour
//                   is attached as DATA, not by the page importing another package.
// The route→plan mapping is an ORDERED list of route-plan rules (first match wins) whose
// match conditions are regex over the path + hash — an open rule set. Adding a route, a
// new anon surface, or a new companion is ONE DATA row, zero code here. The renderer
// stays a blind mount of the resolved plan.

/** A reference to a package surface entry (the universal {package, entry} address).
 *  `surfaceInput` is optional opaque DATA threaded to the mounted surface (e.g. a login
 *  surface's provider/redirect/CTA config) — the router never inspects it. */
export interface PackageEntryReference {
  packageName: string;
  entryName: string;
  surfaceInput?: Record<string, unknown>;
}

/** One chrome component of the signed-in member shell: the universal {package, entry}
 *  address PLUS its scene component id (`materialTarget`). Mounted BY ADDRESS through the
 *  blind ComponentMaterialSurface, exactly like the root scene mounts its components. */
export interface ShellComponentReference {
  packageName: string;
  entryName: string;
  materialTarget: string;
}

// The signed-in member shell: the app chrome. screen-look (theming/background layer),
// screen-arrangement (the navigable workspace of tabs/panels), and sidebar (the nav that
// lists every placeable-surface: Library, Swing Analysis, Your Stats, the courses, checkout,
// booking). These are the SAME three chrome components that were the app root's children
// before the root was narrowed to the gate alone (to stop ANON traffic being wrapped in this
// power-user chrome). Restoring them ONLY on the signed-in branch keeps anon a clean full-page
// gate while a real member gets the full navigable app. Each component reads its own
// already-admitted inputs (placeable-surface-list, layout-state, sidebar-placement) by
// address, so mounting them nested here (vs as scene roots) resolves identically. DATA, not
// code: adding or removing a chrome component is one row here, zero renderer change (L090).
export const DEFAULT_SIGNED_IN_SHELL: ShellComponentReference[] = [
  { packageName: 'screen-look', entryName: 'screen-look', materialTarget: 'component:screen-look' },
  { packageName: 'screen-arrangement', entryName: 'screen-arrangement', materialTarget: 'component:screen-arrangement' },
  { packageName: 'sidebar', entryName: 'sidebar', materialTarget: 'component:sidebar' },
];

/**
 * A route-match condition. `path` / `hash` are regex SOURCES (case-insensitive for hash);
 * both optional and AND-ed; an empty match `{}` is the wildcard (always matches). This is
 * a Physics primitive set (regex string predicates), not an extensible Society vocabulary —
 * a new route is a new DATA rule, never a new operator.
 */
export interface RouteMatch {
  /** Regex tested against the normalized pathname (trailing slashes stripped). */
  path?: string;
  /** Regex tested against the lowercased hash (including any leading '#'). */
  hash?: string;
  /** Regex tested against the lowercased hostname (e.g. `^app\.` for the app subdomain). */
  host?: string;
}

/** One ordered route-plan rule: when `match` matches, this is the resolved plan. */
export interface AnonEntryRoutePlan {
  match: RouteMatch;
  primary: PackageEntryReference;
  /** Per-route extra companions (merged with the set's global companions). */
  companions?: PackageEntryReference[];
}

/** The full anon route-plan DATA: ordered rules + companions mounted on EVERY route. */
export interface AnonEntryRoutePlanSet {
  routes: AnonEntryRoutePlan[];
  /** Headless companions co-mounted on every anon page (e.g. traffic capture). */
  companions?: PackageEntryReference[];
}

/** The resolved plan for a route: the primary surface + all headless companions. */
export interface AnonEntryPlan {
  primary: PackageEntryReference;
  companions: PackageEntryReference[];
}

export type AnonRoute = {
  /** window.location.pathname (or '/' on the server). */
  pathname: string;
  /** window.location.hash including the leading '#', or ''. */
  hash: string;
  /** window.location.hostname (or '' on the server). */
  host: string;
};

/** Read the current anonymous route from the browser (server → home). */
export function currentAnonRoute(): AnonRoute {
  if (typeof window === 'undefined') return { pathname: '/', hash: '', host: '' };
  return {
    pathname: window.location.pathname || '/',
    hash: window.location.hash || '',
    host: window.location.hostname || '',
  };
}

function normalizePath(pathname: string): string {
  const trimmed = (pathname || '/').replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : '/';
}

function matchesRoute(match: RouteMatch, path: string, hash: string, host: string): boolean {
  // Every present condition must hold; an empty match is the wildcard default.
  if (typeof match.path === 'string') {
    try {
      if (!new RegExp(match.path).test(path)) return false;
    } catch {
      return false; // a malformed rule never matches (fail closed, never throws)
    }
  }
  if (typeof match.hash === 'string') {
    try {
      if (!new RegExp(match.hash, 'i').test(hash)) return false;
    } catch {
      return false;
    }
  }
  if (typeof match.host === 'string') {
    try {
      if (!new RegExp(match.host, 'i').test(host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function dedupeEntries(entries: PackageEntryReference[]): PackageEntryReference[] {
  const seen = new Set<string>();
  const out: PackageEntryReference[] = [];
  for (const e of entries) {
    if (!e || typeof e.packageName !== 'string' || typeof e.entryName !== 'string') continue;
    if (e.packageName.length === 0 || e.entryName.length === 0) continue;
    const key = `${e.packageName} ${e.entryName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ packageName: e.packageName, entryName: e.entryName });
  }
  return out;
}

/**
 * Resolve the anon entry plan for a route from DATA: walk the ordered rules, first match
 * wins; merge the set's global companions with the matched rule's companions (deduped,
 * primary excluded so a surface never double-mounts). Returns `null` if no rule matches
 * (a well-formed plan set ends with a wildcard rule, so the caller always gets a plan).
 */
export function resolveAnonEntryPlan(
  route: AnonRoute,
  planSet: AnonEntryRoutePlanSet,
): AnonEntryPlan | null {
  const path = normalizePath(route.pathname);
  const hash = (route.hash || '').toLowerCase();
  const host = (route.host || '').toLowerCase();
  for (const rule of planSet.routes ?? []) {
    if (!rule || !rule.primary) continue;
    if (!matchesRoute(rule.match ?? {}, path, hash, host)) continue;
    const companions = dedupeEntries([...(planSet.companions ?? []), ...(rule.companions ?? [])]).filter(
      (c) => !(c.packageName === rule.primary.packageName && c.entryName === rule.primary.entryName),
    );
    return { primary: { ...rule.primary }, companions };
  }
  return null;
}

// The anon-entry LOGIN primary: the generic, provider-agnostic magic-link login surface
// (account-session::magic-link-login) configured ENTIRELY by `surfaceInput` DATA. The router
// names the provider request TARGET, the magic-link return route, and the sign-up CTA as DATA;
// the surface dispatches the target by name (envelope, zero coupling) and never hardcodes a
// provider. Swapping providers / redirects is a DATA edit here, zero surface code change.
const ANON_MAGIC_LINK_LOGIN: PackageEntryReference = {
  packageName: 'account-session',
  entryName: 'magic-link-login',
  surfaceInput: {
    requestTarget: 'supabase-sign-in.request-sign-in-link',
    redirectPath: '/app?supabase_sign_in=complete',
    ctaHref: 'https://buy.stripe.com/3cI5kCbse5tzb50cXt9bO0b',
  },
};

// ── DEFAULT anon route-plan DATA (the -1000IQ default, L083) ──────────────────────────
//   - checkout route (`/checkout`, any `.../checkout`, or a `#checkout` hash) → checkout,
//     so an anonymous buyer purchases directly (account derived from the checkout email).
//   - explicit auth route (`/login`, `/sign-in`, the app shell `/app`, or a sign-in hash)
//     → the magic-link login surface.
//   - everything else (`/`, `/master-class`, any marketing route) → the sales page. Cold
//     traffic always reaches the product, never a wall.
// Ordered so checkout (transact intent) wins over a sign-in hash. Global companions mounted on
// EVERY anon page: the traffic-capture beacon (reports first-touch source as DATA) and the
// supabase magic-link COMPLETION companion (self-guards on ?supabase_sign_in=complete, so it is
// inert unless the visitor is returning from a magic link, on whichever route the link targets).
export const DEFAULT_ANON_ENTRY_PLAN_SET: AnonEntryRoutePlanSet = {
  companions: [
    { packageName: 'traffic-attribution', entryName: 'traffic-capture' },
    { packageName: 'supabase-sign-in', entryName: 'supabase-sign-in-completion' },
  ],
  routes: [
    { match: { path: '/checkout$' }, primary: { packageName: 'checkout', entryName: 'checkout' } },
    // Public PWYW route: serve the live checkout surface directly so the user-facing
    // URL lands on the real form instead of falling through to the generic sales-page
    // wildcard with no matching page record.
    { match: { path: '^/pay-what-you-want$' }, primary: { packageName: 'checkout', entryName: 'checkout' } },
    { match: { hash: 'checkout' }, primary: { packageName: 'checkout', entryName: 'checkout' } },
    // Purchase-success route (Stripe success_url target → /thank-you, or a #purchased hash):
    // the buyer returns to the SAME browser, so the conversion beacon reads the sticky
    // first-touch observer and attributes the sale to its source. Primary is the login
    // surface (sign in to access the purchase). The traffic-conversion companion fires the
    // append-only conversion fact (in addition to the global traffic-capture visit beacon).
    { match: { path: '^/(thank-you|purchase-complete)$' }, primary: ANON_MAGIC_LINK_LOGIN, companions: [{ packageName: 'traffic-attribution', entryName: 'traffic-conversion' }] },
    { match: { hash: 'purchased|converted' }, primary: ANON_MAGIC_LINK_LOGIN, companions: [{ packageName: 'traffic-attribution', entryName: 'traffic-conversion' }] },
    { match: { path: '^/(login|sign-in|app)$' }, primary: ANON_MAGIC_LINK_LOGIN },
    { match: { hash: 'sign-?in|log-?in' }, primary: ANON_MAGIC_LINK_LOGIN },
    // The `app.` subdomain IS the product: its HOME is the login (enter email → magic link),
    // not the marketing landing. The apex/`www.` marketing domain keeps the landing at `/`
    // via the wildcard below. Host-scoped so only the app subdomain's home flips to login;
    // content routes (`/article/...`) on either host still resolve through the wildcard.
    { match: { host: '^app\\.', path: '^/$' }, primary: ANON_MAGIC_LINK_LOGIN },
    { match: {}, primary: { packageName: 'public-sales-page', entryName: 'public-sales-page' } },
  ],
};
