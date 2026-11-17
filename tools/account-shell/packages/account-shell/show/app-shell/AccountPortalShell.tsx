// packages/account-shell/show/app-shell/AccountPortalShell.tsx
//
// Account portal chrome: sidebar navigation over the published surface catalog
// plus the active surface panel. Surfaces are catalog rows; the active panel is
// mounted by its own package entry bytes. The class names bind to the portal
// stylesheet record (package::screen-look::stored-bytes::bitfield-site-global-look).

'use client';

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { PlaceableSurfaceHost } from '../../../../../ui/show/placeable-surface-host';
import {
  defaultPortalSurfaceId,
  findPortalSurface,
  readPortalSurfaces,
  readSidebarSections,
  type PortalSurface,
} from '../../read-data/read-portal-surfaces';
import {
  requestedSurfaceFromSearch,
  resolveActiveSurfaceId,
  surfaceInputFromSearch,
  surfaceUrl,
} from '../portal-surface-url';

function browserRequestedSurface(): string | null {
  if (typeof window === 'undefined') return null;
  return requestedSurfaceFromSearch(window.location.search);
}

function PortalSidebar({
  activeSurfaceId,
  onSelectSurface,
  surfaces,
}: {
  activeSurfaceId: string | null;
  onSelectSurface: (surfaceId: string) => void;
  surfaces: readonly PortalSurface[];
}) {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const sections = readSidebarSections(surfaces);
  const currentItem = findPortalSurface(surfaces, activeSurfaceId);

  function selectSurface(surfaceId: string) {
    onSelectSurface(surfaceId);
    setDrawerOpen(false);
  }

  return (
    <aside data-bitfield-account-sidebar data-sidebar-open={drawerOpen || undefined}>
      <div className="account-sidebar-mobile-topbar">
        <button
          aria-expanded={drawerOpen}
          aria-label="Open account navigation"
          className="account-sidebar-menu-button"
          onClick={() => setDrawerOpen((open) => !open)}
          type="button"
        >
          <span />
          <span />
          <span />
        </button>
        <strong>{currentItem?.label ?? 'Bitfield account portal'}</strong>
        <span aria-hidden="true" />
      </div>

      <button
        aria-hidden={!drawerOpen}
        className="account-sidebar-backdrop"
        onClick={() => setDrawerOpen(false)}
        tabIndex={drawerOpen ? 0 : -1}
        type="button"
      />

      <div className="account-sidebar-drawer">
        <div className="account-sidebar-brand">
          <strong>Bitfield</strong>
          <span>Account portal</span>
        </div>

        {sections.map((section) => (
          <nav aria-label={section.label} key={section.id}>
            <div className="account-sidebar-section-label">{section.label}</div>
            <div className="account-sidebar-item-list">
              {section.items.map((item) => (
                <a
                  aria-current={item.id === activeSurfaceId ? 'page' : undefined}
                  href={`?surface=${encodeURIComponent(item.id)}`}
                  key={item.id}
                  onClick={(event) => {
                    if (
                      event.defaultPrevented ||
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return;
                    }
                    event.preventDefault();
                    selectSurface(item.id);
                  }}
                >
                  <span>{item.label}</span>
                  <span>{item.description}</span>
                </a>
              ))}
            </div>
          </nav>
        ))}
      </div>
    </aside>
  );
}

export function AccountPortalShell() {
  const surfaceListEntry = useBitfieldData('portal-surface-list');
  const surfaces = React.useMemo(
    () => readPortalSurfaces(surfaceListEntry),
    [surfaceListEntry],
  );
  const defaultSurfaceId = defaultPortalSurfaceId(surfaces);
  const [requestedSurfaceId, setRequestedSurfaceId] = React.useState<string | null>(
    () => browserRequestedSurface(),
  );

  React.useEffect(() => {
    function syncFromLocation() {
      setRequestedSurfaceId(browserRequestedSurface());
    }
    window.addEventListener('popstate', syncFromLocation);
    return () => {
      window.removeEventListener('popstate', syncFromLocation);
    };
  }, []);

  const activeSurfaceId = resolveActiveSurfaceId(surfaces, requestedSurfaceId, defaultSurfaceId);
  const activeSurface = findPortalSurface(surfaces, activeSurfaceId);
  const activeSurfaceInput = surfaceInputFromSearch(
    activeSurface,
    typeof window === 'undefined' ? '' : window.location.search,
  );

  function selectSurface(surfaceId: string) {
    if (typeof window !== 'undefined') {
      window.history.pushState(
        {},
        '',
        surfaceUrl(
          window.location.pathname,
          window.location.search,
          window.location.hash,
          surfaceId,
          defaultSurfaceId,
        ),
      );
    }
    setRequestedSurfaceId(surfaceId);
  }

  const fullBleed = activeSurface ? !activeSurface.wrapMaterial : false;

  return (
    <div
      className="account-portal-body"
      data-account-portal-chrome={fullBleed ? 'none' : 'sidebar'}
    >
      {fullBleed ? null : (
        <PortalSidebar
          activeSurfaceId={activeSurfaceId}
          onSelectSurface={selectSurface}
          surfaces={surfaces}
        />
      )}
      <section
        className="account-screen-arrangement"
        data-bitfield-account-screen-arrangement
      >
        {activeSurface?.packageEntry ? (
          <PlaceableSurfaceHost
            entryName={activeSurface.packageEntry.entryName}
            packageName={activeSurface.packageEntry.packageName}
            materialTarget={activeSurface.materialTarget}
            surfaceInput={activeSurfaceInput}
            target={activeSurface.target}
          />
        ) : (
          <div className="account-screen-arrangement-card">
            {activeSurface
              ? `${activeSurface.label} is not available yet.`
              : 'No account surfaces are published.'}
          </div>
        )}
      </section>
    </div>
  );
}
