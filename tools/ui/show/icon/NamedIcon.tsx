// parts/ui/show/icon/NamedIcon.tsx
//
// Data-driven Lucide icon resolver for pure browser chrome. The icons it can resolve are `./named-icons`: on disk all
// of Lucide, in a browser bundle only the icons the repository names (scripts/named-icons.mjs), so the page never
// carries Lucide's whole registry and no icon name is listed by hand. An icon the first load does not carry keeps its
// room, unseen, until the rest arrive (never drawn meanwhile as the fallback, which flashed as a bolt on Home).

import React from 'react';
import ICONS, { rest } from './named-icons';
import type { LucideProps } from 'lucide-react';
import { Icon, type IconProps } from './Icon';
import { cn } from '../cn';

type LucideComponent = React.ElementType<LucideProps>;

export interface NamedIconProps extends Omit<IconProps, 'icon' | 'name'> {
  name?: string | null;
  fallback?: string;
}

function isLucideComponent(candidate: unknown): candidate is LucideComponent {
  if (typeof candidate === 'function') return true;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    '$$typeof' in candidate
  );
}

/**
 * Resolve a DATA icon name to a Lucide component. Names travel as data in either
 * registry casing ("Trash2") or kebab-case ("trash-2") — the resolver owns the
 * normalization, callers never do. Exported so surfaces that need the icon
 * COMPONENT (e.g. IconTile, which takes a LucideIcon, not a name string) reuse
 * the same resolution NamedIcon uses — one source of truth for name→icon (L090).
 */
export function resolveNamedIcon(name?: string | null): LucideComponent | null {
  if (!name) return null;
  const pascal = name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  const candidate = ICONS[name] ?? ICONS[pascal] ?? later?.[name] ?? later?.[pascal];
  if (isLucideComponent(candidate)) return candidate;
  if (!later) void loadLater();
  return null;
}

// The icons the page's first load does not carry (scripts/named-icons.mjs `rest`): fetched once, the first time a name
// is not found, and every NamedIcon that drew its fallback meanwhile draws again.
let later: Record<string, unknown> | null = null;
let loading: Promise<void> | null = null;
const redrawWhenLater = new Set<() => void>();
function loadLater(): Promise<void> {
  loading ??= rest().then((icons) => {
    later = icons;
    for (const redraw of redrawWhenLater) redraw();
    redrawWhenLater.clear();
  }, () => { loading = null; });
  return loading;
}

// Legacy DATA may carry a Unicode symbol instead of a vector name. Keep the
// same Icon sizing and colour owner for both, including inline record chips.
function SymbolIcon({ children, ...props }: LucideProps) {
  return <svg width="24" height="24" {...props} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <text x="12" y="12" dominantBaseline="central" textAnchor="middle" fontSize="20">{children}</text>
  </svg>;
}

export function NamedIcon({
  name,
  fallback = 'Zap',
  ...props
}: NamedIconProps) {
  const symbol = Boolean(name && !/[A-Za-z]/.test(name) && /\p{S}/u.test(name));
  const own = symbol ? null : resolveNamedIcon(name);
  const [, redraw] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => {
    if (own || !name || symbol) return undefined;
    // The file can arrive after this render but before its effect subscribes. That placeholder still needs a redraw,
    // including when the file did not contain its name and the fallback should now be seen.
    if (later) { redraw(); return undefined; }
    redrawWhenLater.add(redraw);
    return () => { redrawWhenLater.delete(redraw); };
  }, [own, name, symbol]);
  if (symbol) return <Icon icon={SymbolIcon} {...props}>{name}</Icon>;
  const icon = own ?? resolveNamedIcon(fallback) ?? resolveNamedIcon('Circle');
  if (!icon) return null;
  // While the rest of the icons are still on their way, the fallback keeps the icon's room but is never seen, so a
  // named icon never flashes as another icon before it arrives; once they arrived, a name still not found draws it.
  const arriving = !own && !!name && !later;
  return <Icon icon={icon} {...props} className={arriving ? cn(props.className, 'invisible') : props.className} aria-hidden={arriving || props['aria-hidden']} data-named-icon-pending={arriving ? '' : undefined} />;
}
