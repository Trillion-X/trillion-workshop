// parts/ui/show/site-nav/site-nav-look.d.mts
// Types for site-nav-look.mjs, for TypeScript callers such as SiteNav.tsx.

export interface SiteNavLink { label: string; href: string }
export interface SiteNavFeature { id: string; name: string; line: string; icon: string | null; href: string; preview: { src: string; alt: string; width: number; height: number } | null }
export interface SiteNavMenuEntry { id: string; label: string; menu: { heading: string | null; items: SiteNavFeature[]; footer: { label: string; line: string; href: string } | null } }
export interface SiteNavAction { label: string; href: string; primary: boolean }
export function siteNavEntries(nav: unknown): { label: string; items: (SiteNavLink | SiteNavMenuEntry)[]; actions: SiteNavAction[] };
export function siteNavItems(nav: unknown): { label: string; href: string | null }[];
export const SITE_NAV_CSS: string;
export const SITE_NAV_SCRIPT: string;

export interface SiteNavHoverApi {
  isOpen: () => boolean;
  isSoft: () => boolean;
  show: () => void;
  hide: () => void;
}
export function siteNavHover(item: HTMLElement, api: SiteNavHoverApi, delays?: { open?: number; close?: number }): { cancel: () => void; destroy: () => void };
