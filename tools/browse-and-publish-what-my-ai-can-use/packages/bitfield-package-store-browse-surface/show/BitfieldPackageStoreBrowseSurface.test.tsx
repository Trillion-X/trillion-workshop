import React from 'react';
import packageStoreCatalog from '../../bitfield-package-store-catalog/data/catalog.json';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BitfieldPackageStoreBrowseSurface } from './BitfieldPackageStoreBrowseSurface';

const catalog = {
  catalog_rows: [
    {
      row_kind: 'package-row',
      row_id: 'test-package-row',
      package_identity: 'screen-look',
      display_name: 'Screen Look',
      summary: 'Theme controls for a Bitfield product.',
      install: {
        target: 'package-files.install-packages-from-pointers',
        install_subject: {
          action_label: 'Install package',
          package_identity: 'screen-look',
          subject_label: 'Screen Look',
          subject_ref: 'package-file:screen-look',
          subject_type_ref: 'package',
        },
      },
      exchange: {
        access: {
          admission_fact_refs: ['package-use:public:screen-look'],
          product_access_proof_refs: [],
          required_owner_target_refs: [],
        },
        package_file_download_pointer_object_keys: [
          'package-sets/bitfield-package-store/package-files/screen-look.bitfield-package.json',
        ],
        package_file_metadata_pointer_refs: ['package-file-metadata:screen-look'],
        package_use_decision_refs: ['package-use:public:screen-look'],
        provenance_refs: ['resource:screen-look'],
        update_policy_refs: ['update-policy:manual-approval'],
      },
      package_finding: {
        capabilities: ['Screen look'],
        facets: [{ group: 'category', id: 'category:look', label: 'Look' }],
        ranking: { score: 10 },
        shelf_ids: ['featured'],
        title: 'Screen Look',
      },
      visibility: {
        execution: 'runs-locally',
        source: 'code-visible',
      },
    },
  ],
};

const browseConfig = {
  local_package_file_request_defaults: {
    object_store_method: 'http',
    object_store_settings_json: '{"base_url":"https://packages.bitfield.so/objects"}',
  },
  row_kinds: [{ id: 'package-row', label: 'Packages' }],
  storefront_filter_groups: ['category'],
};

const installDestinations = {
  install_destination_options: [
    {
      detail: 'Main workspace.',
      label: 'Bitfield Studio',
      package_set: 'bitfield-studio',
    },
    {
      detail: 'Public tennis app.',
      label: 'Ethos School of Tennis',
      package_set: 'ethos-school-of-tennis',
    },
  ],
};

function installActionCapabilities() {
  return {
    action_requirements: [
      {
        action_ref: 'action:store-install',
        target_refs: [
          'bitfield-package-store.request-accept-package-files',
          'package-files.install-packages-from-pointers',
        ],
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, '__BITFIELD_BOOT_HOOKS__');
  window.history.pushState(null, '', '/');
});

describe('Bitfield Package Store install action', () => {
  it('installs through the catalog row target using the selected log-owned destination feed', async () => {
    window.history.pushState(null, '', '/?package=test-package-row');
    const invoke = vi.fn(async (_target: string, payload: Uint8Array) => {
      const body = JSON.parse(new TextDecoder().decode(payload));
      return new TextEncoder().encode(JSON.stringify({
        imported_packages: [
          { package: 'screen-look', package_set: body.target_package_set },
        ],
        target_package_set: body.target_package_set,
        target_package_set_install_ref: 'package-file-install:screen-look',
      }));
    });
    Object.assign(globalThis, {
      __BITFIELD_BOOT_HOOKS__: {
        connect: async () => ({ transport: { invoke } }),
      },
    });

    render(
      <BitfieldPackageStoreBrowseSurface
        actionCapabilities={installActionCapabilities()}
        browseConfig={browseConfig}
        catalog={catalog}
        installDestinations={installDestinations}
      />,
    );

    await screen.findByText('Install into');
    const destination = screen.getByRole('combobox');
    fireEvent.change(destination, { target: { value: 'ethos-school-of-tennis' } });
    fireEvent.click(screen.getByRole('button', { name: 'Install package' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const [target, payload] = invoke.mock.calls[0];
    expect(target).toBe('package-files.install-packages-from-pointers');
    expect(JSON.parse(new TextDecoder().decode(payload))).toMatchObject({
      package_identities: ['screen-look'],
      target_package_set: 'ethos-school-of-tennis',
    });
  });

  it('renders founder capability compositions and reuses the catalog search CTA', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    Object.assign(globalThis, {
      IntersectionObserver: class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    });
    render(
      <BitfieldPackageStoreBrowseSurface
        browseConfig={browseConfig}
        catalog={packageStoreCatalog}
      />,
    );

    expect(screen.getByText('Replace a stack. Keep the pieces.')).toBeTruthy();
    expect(screen.getByText('Customer and member portals')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Explore portal pieces' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Explore portal pieces' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Search packages' }) as HTMLInputElement).value).toBe('customer portal'));
  });

  it('renders every request-to-build field from data and emits the structured payload', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    Object.assign(globalThis, {
      IntersectionObserver: class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    });
    const received: CustomEvent[] = [];
    const listener = (event: Event) => received.push(event as CustomEvent);
    window.addEventListener('bitfield:replacement-request', listener);
    render(
      <BitfieldPackageStoreBrowseSurface
        browseConfig={browseConfig}
        catalog={packageStoreCatalog}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Search packages' }), { target: { value: 'quantum payroll' } });
    await screen.findByText('This capability is not present in the current catalog.');
    fireEvent.change(screen.getByRole('textbox', { name: 'What should it do?' }), { target: { value: 'Payroll approvals' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'What proof would make this credible?' }), { target: { value: 'A verified payroll export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request a composition' }));

    expect(received).toHaveLength(1);
    expect(received[0].detail).toMatchObject({
      target: 'data://package-store/replacement-catalog/request-to-build',
      capability_request: 'Payroll approvals',
      evidence_needed: 'A verified payroll export',
    });
    window.removeEventListener('bitfield:replacement-request', listener);
  });
});
