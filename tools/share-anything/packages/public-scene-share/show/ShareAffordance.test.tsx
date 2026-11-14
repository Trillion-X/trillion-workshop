// @vitest-environment jsdom
// packages/public-scene-share/show/ShareAffordance.test.tsx
//
// Proves the REAL Share button drives the full lifecycle on a real DOM:
// idle → click → minting → shared (URL + Copy) → copy; and the error path.
// The live mint + clipboard are injected, so this exercises the component's
// state machine + the presenter wiring without any engine/platform dependency.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ShareAffordance } from '@/packages/public-scene-share/show/ShareAffordance';
import type { CapsuleReply } from '@/packages/public-scene-share/show/share-scene-presenter';

const config = { publicShareOrigin: 'http://localhost:4599' };
afterEach(() => cleanup());

const btn = () => screen.getByRole('button');

describe('ShareAffordance', () => {
  it('idle → mint → shared shows the /c/<hash> link and a Copy action', async () => {
    const reply: CapsuleReply = { ok: true, capsuleHash: '1f:abc123', contentPath: '/cas/1f:abc123' };
    const onMint = vi.fn(async () => reply);
    render(<ShareAffordance config={config} onMint={onMint} copyUrl={async () => {}} />);

    expect(btn().textContent).toMatch(/Share this view/i);
    expect(screen.queryByText(/\/c\//)).toBeNull();

    fireEvent.click(btn());

    await waitFor(() => expect(screen.getByText('http://localhost:4599/c/1f:abc123')).toBeTruthy());
    expect(onMint).toHaveBeenCalledTimes(1);
    expect(btn().textContent).toMatch(/Copy link/i);
  });

  it('copy writes the URL via the injected clipboard and confirms', async () => {
    const reply: CapsuleReply = { ok: true, capsuleHash: '1f:deadbeef' };
    const copyUrl = vi.fn(async () => {});
    render(<ShareAffordance config={config} onMint={async () => reply} copyUrl={copyUrl} />);
    fireEvent.click(btn());
    await waitFor(() => screen.getByText('http://localhost:4599/c/1f:deadbeef'));
    fireEvent.click(btn()); // now "Copy link"
    await waitFor(() => expect(copyUrl).toHaveBeenCalledWith('http://localhost:4599/c/1f:deadbeef'));
    await waitFor(() => expect(btn().textContent).toMatch(/Copied/i));
  });

  it('an unsuccessful reply (ok but no hash) is an error, never a silent success', async () => {
    render(<ShareAffordance config={config} onMint={async () => ({ ok: true })} copyUrl={async () => {}} />);
    fireEvent.click(btn());
    await waitFor(() => expect(btn().textContent).toMatch(/Try again/i));
    expect(screen.queryByText(/\/c\//)).toBeNull();
  });

  it('a thrown mint surfaces an error (no blank, no crash)', async () => {
    render(<ShareAffordance config={config} onMint={async () => { throw new Error('engine offline'); }} copyUrl={async () => {}} />);
    fireEvent.click(btn());
    await waitFor(() => expect(screen.getByText(/engine offline/i)).toBeTruthy());
    expect(btn().textContent).toMatch(/Try again/i);
  });

  it('no deploy target connected (isPubliclyReachable: false) shows the honest state up front — never mints a fake localhost link', async () => {
    const unreachableConfig = { publicShareOrigin: 'http://localhost:4599', isPubliclyReachable: false };
    const onMint = vi.fn(async () => ({ ok: true, capsuleHash: '1f:should-never-mint' }) as CapsuleReply);
    render(<ShareAffordance config={unreachableConfig} onMint={onMint} copyUrl={async () => {}} />);

    expect(btn().textContent).toMatch(/connect a deploy target/i);
    expect(screen.queryByText(/\/c\//)).toBeNull();
    expect((btn() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(btn());
    await waitFor(() => expect(btn().textContent).toMatch(/connect a deploy target/i));
    expect(onMint).not.toHaveBeenCalled();
    expect(screen.queryByText(/\/c\//)).toBeNull();
  });
});
