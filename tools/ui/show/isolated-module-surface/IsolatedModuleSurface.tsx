'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { checkedLook, moduleSurfaceDocument } from './module-surface-document.mjs';
import { moduleSurfaceImportMap, moduleSurfaceMediaAddress, moduleSurfaceMediaIdentities, savedScreenModuleAddress } from './module-surface-requests.mjs';
import { resourceTaskOutcomeFromError } from './resource-task-outcome.mjs';

export type ModuleSurfaceRequestMap = Record<string, unknown>;
export type ModuleSurfaceCall = (name: string, input?: Record<string, unknown>) => Promise<unknown>;
export type ModuleSurfaceMediaLease = (identity: string, surfaceInput: Record<string, unknown>) => Promise<unknown>;
export interface IsolatedModuleSurfaceProps {
  bundle: string;
  file: string;
  surfaceInput?: Record<string, unknown>;
  requests?: ModuleSurfaceRequestMap;
  onCall: ModuleSurfaceCall;
  onMediaLease: ModuleSurfaceMediaLease;
  title: string;
  inputUpdateId?: string;
  onInputUpdateResult?: (id: string, accepted: boolean) => void;
}

const safeError = 'This screen could not open.';
const readyMessage = 'trillion-module-surface:init';
const LOOK_ATTRIBUTES = ['data-theme', 'data-screen-look-theme', 'data-look-scheme'];

/** A srcdoc frame inherits this page's Content-Security-Policy, so its scripts carry the nonce the engine gave this
 * page response (on the import map). A page served without one leaves the frame a fresh nonce of its own. */
function frameNonce(): string {
  return document.querySelector<HTMLScriptElement>('script[type="importmap"][nonce]')?.nonce || crypto.randomUUID().replaceAll('-', '_');
}

/** The Screen Look this page wears now, passed as bounded data to the saved screen's isolated document. */
function wornLook() {
  const root = document.documentElement;
  const variables: Record<string, string> = {};
  for (let index = 0; index < root.style.length; index += 1) {
    const name = root.style[index];
    if (name.startsWith('--')) variables[name] = root.style.getPropertyValue(name).trim();
  }
  return checkedLook({ attributes: Object.fromEntries(LOOK_ATTRIBUTES.map(name => [name, root.getAttribute(name)])), variables });
}

/** Runs a saved screen in a script-only opaque-origin frame with named host capabilities. */
export function IsolatedModuleSurface({ bundle, file, surfaceInput = {}, requests = {}, onCall, onMediaLease, title, inputUpdateId, onInputUpdateResult }: IsolatedModuleSurfaceProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef<MessagePort | null>(null);
  const onCallRef = useRef(onCall);
  const onMediaLeaseRef = useRef(onMediaLease);
  const surfaceInputRef = useRef(surfaceInput);
  const inputUpdateIdRef = useRef(inputUpdateId);
  const serviceOriginRef = useRef('');
  const mediaLeases = useRef(new Map<string, { address: Promise<string>; expiresAt: number | null }>());
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(320);
  onCallRef.current = onCall;
  onMediaLeaseRef.current = onMediaLease;
  surfaceInputRef.current = surfaceInput;
  inputUpdateIdRef.current = inputUpdateId;
  const documentPromise = useMemo(() => {
    const nonce = frameNonce();
    const serviceOrigin = new URL(import.meta.url).origin;
    return fetch(`${serviceOrigin}/workspace/files.json`, { credentials: 'omit' })
      .then(response => { if (!response.ok) throw new Error(safeError); return response.json(); })
      .then(files => {
        if (typeof files?.stylesheet !== 'string') throw new Error(safeError);
        const moduleUrl = savedScreenModuleAddress(bundle, file, serviceOrigin);
        serviceOriginRef.current = serviceOrigin;
        return moduleSurfaceDocument({ moduleUrl, importMap: moduleSurfaceImportMap(files, serviceOrigin), stylesheetUrl: files.stylesheet, nonce, serviceOrigin });
      });
  }, [bundle, file]);
  const [srcDoc, setSrcDoc] = useState('');

  useEffect(() => { let live = true; setFailed(false); void documentPromise.then(value => { if (live) setSrcDoc(value); }, () => { if (live) setFailed(true); }); return () => { live = false; }; }, [documentPromise]);

  useLayoutEffect(() => {
    const iframe = frame.current;
    if (!iframe || !srcDoc) return;
    let active = true;
    const portChannel = new MessageChannel();
    channel.current?.close();
    channel.current = portChannel.port1;
    portChannel.port1.onmessage = event => {
      const message = event.data;
      if (!active || !message || typeof message !== 'object') return;
      if (message.type === 'ready') return;
      if (message.type === 'size' && typeof message.height === 'number' && Number.isFinite(message.height)) {
        setHeight(Math.max(320, Math.min(8192, Math.ceil(message.height))));
        return;
      }
      if (message.type === 'failure') { setFailed(true); return; }
      if ((message.type === 'update-accepted' || message.type === 'update-refused') && typeof message.id === 'string') {
        onInputUpdateResult?.(message.id, message.type === 'update-accepted');
        return;
      }
      if (message.type === 'media') {
        if (typeof message.id !== 'string' || !/^\d{1,12}$/.test(message.id)) return;
        const id = message.id;
        if (typeof message.identity !== 'string' || !moduleSurfaceMediaIdentities(surfaceInputRef.current).has(message.identity)) {
          portChannel.port1.postMessage({ type: 'media-response', id, ok: false });
          return;
        }
        const identity = message.identity;
        const input = surfaceInputRef.current;
        const leaseKey = JSON.stringify([identity, input.account_id ?? null, input.person_id ?? null, input.user_id ?? null, input.space_id ?? null, input.item_id ?? null]);
        let cached = mediaLeases.current.get(leaseKey);
        if (cached?.expiresAt !== null && cached?.expiresAt !== undefined && cached.expiresAt <= Date.now()) {
          mediaLeases.current.delete(leaseKey);
          cached = undefined;
        }
        let address = cached?.address;
        if (!address) {
          const serviceOrigin = serviceOriginRef.current;
          const lease = onMediaLeaseRef.current;
          if (!serviceOrigin || !lease) {
            portChannel.port1.postMessage({ type: 'media-response', id, ok: false });
            return;
          }
          const entry: { address: Promise<string>; expiresAt: number | null } = { address: Promise.resolve(''), expiresAt: null };
          address = Promise.resolve().then(() => lease(identity, input))
            .then(payload => {
              if (!payload || typeof payload !== 'object' || Array.isArray(payload)
                || (payload as { scope?: unknown }).scope !== 'read' || (payload as { identity?: unknown }).identity !== identity) throw new Error(safeError);
              const expiry = (payload as { expires_at?: unknown; url_expires_at?: unknown }).expires_at
                ?? (payload as { url_expires_at?: unknown }).url_expires_at;
              const expiresAt = typeof expiry === 'string' ? Date.parse(expiry) : Number.NaN;
              if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error(safeError);
              let token = (payload as { lease?: unknown }).lease;
              const link = (payload as { url?: unknown }).url;
              if (link !== undefined) {
                if (typeof link !== 'string') throw new Error(safeError);
                const url = new URL(link);
                const bytePaths = [`/namespace/bytes/${identity}`, `/namespace/bytes/${encodeURIComponent(identity)}`];
                if (url.origin !== serviceOrigin || url.username || url.password || !bytePaths.includes(url.pathname)
                  || url.hash || [...url.searchParams.keys()].some(key => key !== 'lease') || url.searchParams.getAll('lease').length !== 1) throw new Error(safeError);
                token = url.searchParams.get('lease') ?? undefined;
              }
              entry.expiresAt = expiresAt;
              return moduleSurfaceMediaAddress(identity, token as string, serviceOrigin);
            });
          entry.address = address;
          address.catch(() => { if (mediaLeases.current.get(leaseKey) === entry) mediaLeases.current.delete(leaseKey); });
          mediaLeases.current.set(leaseKey, entry);
        }
        void address.then(
          value => { if (active) portChannel.port1.postMessage({ type: 'media-response', id, ok: true, value }); },
          () => { if (active) portChannel.port1.postMessage({ type: 'media-response', id, ok: false }); },
        );
        return;
      }
      if (message.type !== 'call' || typeof message.id !== 'string' || !/^\d{1,12}$/.test(message.id) || typeof message.name !== 'string') return;
      const call = onCallRef.current;
      void Promise.resolve().then(() => call(message.name, message.input)).then(
        value => { if (active) portChannel.port1.postMessage({ type: 'response', id: message.id, ok: true, value }); },
        error => {
          if (!active) return;
          const taskOutcome = resourceTaskOutcomeFromError(error);
          portChannel.port1.postMessage({ type: 'response', id: message.id, ok: false,
            ...(taskOutcome ? { taskOutcome: { type: 'resource-task-outcome', task: taskOutcome } } : {}) });
        },
      );
    };
    portChannel.port1.start();
    // The iframe can finish loading after its parent has already received a newer target input.
    // Read both values at load time so the initial mount and its acknowledgement match that target.
    const sendInit = () => iframe.contentWindow?.postMessage({
      type: readyMessage,
      surfaceInput: surfaceInputRef.current,
      inputUpdateId: inputUpdateIdRef.current,
      look: wornLook(),
    }, '*', [portChannel.port2]);
    iframe.addEventListener('load', sendInit, { once: true });
    // A saved screen follows the chosen look, but only receives allowlisted attributes and bounded custom properties.
    const lookChanges = new MutationObserver(() => { if (active) portChannel.port1.postMessage({ type: 'look', look: wornLook() }); });
    lookChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['style', ...LOOK_ATTRIBUTES] });
    return () => {
      active = false;
      lookChanges.disconnect();
      iframe.removeEventListener('load', sendInit);
      try { portChannel.port1.postMessage({ type: 'dispose' }); } catch { /* the frame may already be gone */ }
      portChannel.port1.close();
      channel.current = null;
    };
  }, [srcDoc]);

  useEffect(() => {
    if (inputUpdateId) channel.current?.postMessage({ type: 'update', id: inputUpdateId, surfaceInput });
  }, [inputUpdateId, surfaceInput]);

  if (failed) return <div role="status">{safeError}</div>;
  return <iframe
    ref={frame}
    title={title}
    sandbox="allow-scripts"
    referrerPolicy="no-referrer"
    srcDoc={srcDoc || '<!doctype html><html><body></body></html>'}
    style={{ display: 'block', width: '100%', minHeight: 320, height, border: 0 }}
    data-request-capabilities={Object.keys(requests).length}
  />;
}
