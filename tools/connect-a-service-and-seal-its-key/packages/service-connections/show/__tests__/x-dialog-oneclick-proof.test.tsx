// Pixel-proof harness: render the REAL ServiceConnectionDialog fed by the REAL
// decoder (buildServiceConnectionDisplayList path) with the LIVE X descriptor
// payload, dump document.body DOM for screenshotting. Proves the X card opens
// as a one-click sign-in, not a token paste box.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { writeFileSync } from 'node:fs';
import { ServiceConnectionDialog } from '@/packages/service-connections/show/ServiceConnectionDialog';
import { readServiceConnectionOptions } from '@/packages/service-connections/read-data/read-service-connection-options';

// The LIVE X descriptor exactly as served by studio :3012 (read from the aggregate 2026-07-22).
const LIVE_X_DESCRIPTOR = {
  kind: 'service-connection-descriptor',
  vendor: 'x',
  name: 'X (Twitter)',
  instructions: 'Post to your X account and pull your bookmarks.',
  category: 'Publishing',
  logoUrl: 'https://unavatar.io/x.com',
  acquire: {
    flow: 'oauth2_auth_code', pkce: true, client_auth: 'basic',
    authorize_url: 'https://x.com/i/oauth2/authorize',
    token_url: 'https://api.x.com/2/oauth2/token',
    client_path: '.bitfield/credentials-vault/x-oauth-client.json',
    scopes: ['tweet.read','tweet.write','users.read','bookmark.read','offline.access'],
    redirect: { transport: 'loopback', port_range: [4173,4173], path: '/' },
    identity: { userinfo_url: 'https://api.x.com/2/users/me', label_path: ['data','username'] },
    process: { argv: ['node','do-work/process-scripts/acquire-credential.mjs','--in','acquire.json','--out','acquire-result.json'], outputs: [{content_type:'application/json',mount_path:'acquire-result.json'}], timeout_ms: 300000 },
    store: { vault_key: 'x-oauth', vault_target: 'credentials-vault::x-oauth' },
  },
  defaultScopes: ['tweet.read','tweet.write','users.read','bookmark.read'],
  helperLinks: [],
};

describe('X connect dialog (live descriptor)', () => {
  it('renders the one-click acquire shape, not a token paste box', () => {
    const configs = readServiceConnectionOptions([
      { address: 'package::service-connections::published-record::x', payload: LIVE_X_DESCRIPTOR },
    ]);
    expect(configs).toHaveLength(1);
    const x = configs[0];
    expect(x.acquire).toBeTruthy();

    render(
      <ServiceConnectionDialog
        open
        serviceName="X (Twitter)"
        serviceVendor="x"
        providerIconRegistry={[{
          kind: 'provider-icon',
          provider_slug: 'x',
          icon_id: 'logos:x',
          asset: { kind: 'bundled-svg', id: 'logos:x' },
        }]}
        authConfig={x}
        onClose={() => {}}
        onAuthenticate={async () => {}}
        onAcquire={async () => ({ account_label: '', credential_handle_ref: '' })}
      />,
    );
    const html = document.body.innerHTML;
    writeFileSync('/tmp/x-dialog-dom.html', html);
    // one-click shape: NO token input field
    expect(html).not.toContain('Paste your X access token');
    expect(html).not.toContain('OAuth 2.0 Access Token');
    // the acquire affordance is present
    expect(html.toLowerCase()).toMatch(/sign in|ready to connect|connect/);
    const mark = document.body.querySelector<HTMLElement>('[data-provider-mark="x"]');
    expect(mark?.getAttribute('data-provider-icon-id')).toBe('logos:x');
    expect(mark?.getAttribute('data-provider-mark-kind')).toBe('brand');
    expect(mark?.classList.contains('border-0')).toBe(true);
    expect(mark?.style.borderWidth).toBe('0px');
    expect(mark?.style.backgroundColor).toBe('transparent');
  });
});
