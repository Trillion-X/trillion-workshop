// packages/ui/show/source-bytes-screen-mount/SourceBytesScreenMount.tsx
//
// Browser-local sink for already-read package entry bytes. Runtime Kit reads stay
// in the caller package; this component only owns DOM lifecycle for the shared
// thing-to-put-on-screen runtime.

'use client';

import React from 'react';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { hearKept, KEPT_KEY } from '../placement-kept/placement-kept';
export type SourceBytesScreenMountElement = HTMLDivElement & {
  _thingToPutOnScreenCleanup?: () => void;
};

// A program to mount: either the raw bytes, or a live-source POINTER (an address
// descriptor the painter resolves + subscribes to itself, fetching the program
// by content identity from CAS instead of receiving the payload inline).
export type SourceBytesScreenMountProgram =
  | Uint8Array
  | { readonly address_label: string; readonly partition_label?: string };

export interface SourceBytesScreenMountRequest {
  screenPlace: HTMLElement | { element: HTMLElement };
  sourceBytes: SourceBytesScreenMountProgram;
  sourceKey: string;
  props?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  requiredCapabilities?: string[];
}

export interface SourceBytesScreenRuntime {
  putSourceBytesOnScreen: (request: SourceBytesScreenMountRequest) => Promise<void> | void;
}

export interface SourceBytesScreenMountProps {
  sourceBytes: unknown;
  sourceKey: string;
  mountProps?: Record<string, unknown>;
  className?: string;
  mountClassName?: string;
  surfaceDataAttributes?: Record<string, string | null | undefined>;
  dataAttributes?: Record<string, string | null | undefined>;
  loadingText?: string;
  unavailableText?: string;
  runtimeUnavailableText?: string;
  mountTimeoutMs?: number;
  renderFailedText?: (message: string) => string;
}

// L114/L118: the customer-facing copy must NEVER contain the raw error or an
// internal address (e.g. "package::group::entry-bytes::group-board"). The raw
// detail (the `message` argument) is logged to the console for diagnostics; the
// UI shows a plain-language fallback instead. Callers may override with their own
// human copy via the `renderFailedText` prop.
function defaultRenderFailedText(_message: string): string {
  return 'This screen couldn’t open. Give it a moment, then try again.';
}

declare global {
  interface Window {
    __THINGS_TO_PUT_ON_SCREEN__?: SourceBytesScreenRuntime;
  }
}

function readRuntime(): SourceBytesScreenRuntime | null {
  if (typeof window === 'undefined') return null;
  const runtime = window.__THINGS_TO_PUT_ON_SCREEN__;
  return runtime && typeof runtime.putSourceBytesOnScreen === 'function' ? runtime : null;
}

export function cleanupSourceBytesScreenMount(node: SourceBytesScreenMountElement | null): void {
  if (!node) return;
  if (typeof node._thingToPutOnScreenCleanup === 'function') {
    try {
      node._thingToPutOnScreenCleanup();
    } catch {
      // A stale material cleanup must not block replacing this mount point.
    }
    delete node._thingToPutOnScreenCleanup;
  }
  node.replaceChildren();
}

export function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array');
}

// A live-source POINTER: an address descriptor the painter resolves + subscribes
// to itself (it fetches the program by content identity from CAS, never through
// this data path). Passing the pointer straight through — instead of pulling the
// multi-MB payload here — is what makes surface open address-by-identity.
export function isLiveSourcePointer(value: unknown): value is { address_label: string } {
  if (!value || typeof value !== 'object' || isUint8Array(value)) return false;
  const label = (value as { address_label?: unknown; addressLabel?: unknown }).address_label
    ?? (value as { addressLabel?: unknown }).addressLabel;
  return typeof label === 'string' && label.length > 0;
}

export function sourceBytesContentKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (!isUint8Array(value)) return `not-bytes:${typeof value}:${stableValueKey(value)}`;

  let hash = 0x811c9dc5;
  for (let index = 0; index < value.byteLength; index += 1) {
    hash ^= value[index] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `bytes:${value.byteLength}:${hash.toString(16).padStart(8, '0')}`;
}

export function stableValueKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableValueKey(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValueKey(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function applyDataAttributes(
  node: SourceBytesScreenMountElement,
  dataAttributes: Record<string, string | null | undefined> | undefined,
): void {
  if (!dataAttributes) return;
  for (const [key, value] of Object.entries(dataAttributes)) {
    if (value === null || value === undefined) {
      delete node.dataset[key];
    } else {
      node.dataset[key] = value;
    }
  }
}

function dataAttributesToHtmlProps(
  dataAttributes: Record<string, string | null | undefined> | undefined,
): Record<string, string> {
  if (!dataAttributes) return {};
  const props: Record<string, string> = {};
  for (const [key, value] of Object.entries(dataAttributes)) {
    if (value === null || value === undefined) continue;
    const attribute = key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
    props[`data-${attribute}`] = value;
  }
  return props;
}

function mountDeadline(timeoutMs: number, sourceKey: string): Promise<never> {
  return new Promise((_, reject) => {
    window.setTimeout(() => {
      reject(new Error(`Timed out opening package entry bytes for ${sourceKey}`));
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// View transform (auto-fit + zoom) — DATA on the ONE seam every mount crosses.
// ---------------------------------------------------------------------------

/** Fallback zoom bounds when the caller's DATA sets none. Society values a
 *  surface may override per-mount (`frame_zoom_min`/`frame_zoom_max`). */
const VIEW_TRANSFORM_DEFAULT_BOUNDS = { min: 0.25, max: 4 } as const;

interface SurfaceViewTransformInput {
  /** Explicit scale factor (DATA). 0/absent = none. */
  readonly zoom: number;
  /** Design width in px — auto-fit derives scale = hostWidth / designWidth. */
  readonly fitWidth: number;
  /** Cmd/Ctrl+wheel live zoom enabled. */
  readonly zoomable: boolean;
  readonly min: number;
  readonly max: number;
}

function positiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Read the view-transform keys from the mount's opaque surfaceInput DATA.
 *  Every consumer (board node, tab, container, scene) sets these as DATA;
 *  this seam is the only code that interprets them (L090). */
export function readSurfaceViewTransform(mountProps: Record<string, unknown> | undefined): SurfaceViewTransformInput {
  const input = (mountProps?.surfaceInput ?? {}) as Record<string, unknown>;
  return {
    zoom: positiveNumber(input.frame_zoom),
    fitWidth: positiveNumber(input.frame_fit_width),
    zoomable: input.frame_zoomable === true,
    min: positiveNumber(input.frame_zoom_min) || VIEW_TRANSFORM_DEFAULT_BOUNDS.min,
    max: positiveNumber(input.frame_zoom_max) || VIEW_TRANSFORM_DEFAULT_BOUNDS.max,
  };
}

/** Resolve the effective scale. Precedence: live user zoom > DATA zoom >
 *  auto-fit (host/design width) > 1. Pure — unit-tested directly. */
export function resolveSurfaceScale(
  t: SurfaceViewTransformInput,
  userZoom: number,
  hostWidth: number,
): number {
  const clamp = (z: number) => Math.min(t.max, Math.max(t.min, z));
  if (userZoom > 0) return clamp(userZoom);
  if (t.zoom > 0) return clamp(t.zoom);
  // Auto-fit is a FIT, not a zoom: it must reach whatever scale makes the whole
  // design width fit the host (a 1280 design in a 240px tile needs 0.1875).
  // Clamping fit by the zoom floor re-crops exactly the tiles fit exists for —
  // so fit honors only the ceiling. The min/max bounds govern USER/DATA zoom.
  if (t.fitWidth > 0 && hostWidth > 0) return Math.min(t.max, hostWidth / t.fitWidth);
  return 1;
}

export function SourceBytesScreenMount({
  sourceBytes,
  sourceKey,
  mountProps,
  className = 'relative h-full w-full min-h-0 overflow-y-auto overscroll-contain',
  mountClassName = 'h-full min-h-full w-full',
  surfaceDataAttributes,
  dataAttributes,
  loadingText = 'Opening...',
  unavailableText,
  runtimeUnavailableText = 'This screen cannot open yet.',
  mountTimeoutMs = 15000,
  renderFailedText = defaultRenderFailedText,
}: SourceBytesScreenMountProps) {
  const mountRef = React.useRef<SourceBytesScreenMountElement | null>(null);
  const [status, setStatus] = React.useState<string | null>(loadingText);
  // A large bundle can time out on the FIRST open under engine-thread contention
  // yet succeed on a retry once the thread frees — so a failed mount offers a
  // "Try again" that re-runs the mount effect (bumping this nonce), instead of
  // stranding the user on a dead error screen.
  const [retryNonce, setRetryNonce] = React.useState(0);
  // Whether the CURRENT status is a failed-open (retryable) vs a normal loading
  // state — drives the error overlay + Retry affordance without string-matching
  // the human copy.
  const [failed, setFailed] = React.useState(false);
  const retryMount = React.useCallback(() => {
    setFailed(false);
    setStatus(loadingText);
    setRetryNonce((nonce) => nonce + 1);
  }, [loadingText]);
  const sourceBytesKey = React.useMemo(() => sourceBytesContentKey(sourceBytes), [sourceBytes]);
  // What the screen kept in its placement (placement-kept.ts) never remounts it, since it already shows it; a `kept`
  // anyone else wrote (an AI rearranging, another device) does.
  const keptByScreen = React.useRef(new Set<string>());
  const keptKey = stableValueKey((mountProps?.surfaceInput as Record<string, unknown> | undefined)?.[KEPT_KEY] ?? null);
  const shownKept = React.useRef(keptKey);
  if (keptKey !== shownKept.current && !keptByScreen.current.has(keptKey)) shownKept.current = keptKey;
  const mountPropsKey = React.useMemo(() => {
    const input = mountProps?.surfaceInput as Record<string, unknown> | undefined;
    const { [KEPT_KEY]: _kept, ...rest } = input ?? {};
    return `${stableValueKey({ ...(mountProps ?? {}), surfaceInput: rest })}|${shownKept.current}`;
  }, [mountProps, shownKept.current]); // eslint-disable-line react-hooks/exhaustive-deps
  const dataAttributesKey = React.useMemo(() => stableValueKey(dataAttributes ?? {}), [dataAttributes]);
  const surfaceDataProps = React.useMemo(
    () => dataAttributesToHtmlProps(surfaceDataAttributes),
    [surfaceDataAttributes],
  );

  // View transform (auto-fit + zoom) from opaque surfaceInput DATA. When no
  // transform keys are present the render below is byte-identical to before
  // (scale === 1 fast path) — zero risk to every existing mount.
  const viewTransform = React.useMemo(() => readSurfaceViewTransform(mountProps), [mountPropsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const outerRef = React.useRef<HTMLDivElement | null>(null);
  const [hostWidth, setHostWidth] = React.useState(0);
  const [userZoom, setUserZoom] = React.useState(0);
  React.useLayoutEffect(() => {
    if (viewTransform.fitWidth <= 0) return undefined;
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setHostWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewTransform.fitWidth]);
  const scale = resolveSurfaceScale(viewTransform, userZoom, hostWidth);
  const onWheelZoom = React.useMemo(() => {
    if (!viewTransform.zoomable) return undefined;
    return (event: React.WheelEvent) => {
      // Plain scroll stays with the surface; only the OS zoom chord captures.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation(); // an outer canvas camera must not ALSO zoom
      const step = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setUserZoom((current) => {
        const base = current > 0 ? current : scale;
        return Math.min(viewTransform.max, Math.max(viewTransform.min, base * step));
      });
    };
  }, [viewTransform, scale]);
  // Scale container pattern: the outer box keeps the host's layout size and
  // clips; the inner plane is size-compensated (W/z × H/z) then scaled by z with
  // origin 0 0 — so the embedded root still measures/paints at its design size
  // and pointer coordinates stay coherent inside the scaled plane.
  const transformStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (scale === 1) return undefined;
    const pct = `${(100 / scale).toFixed(4)}%`;
    // minHeight: 0 neutralizes the default `min-h-full` mount class, which would
    // otherwise floor the compensated plane at 100% and break scale-up.
    return { width: pct, height: pct, minHeight: 0, transform: `scale(${scale})`, transformOrigin: '0 0' };
  }, [scale]);
  // Hover reveal for the zoom pill — React state (not a CSS :hover chain)
  // because the pill must appear when the OUTER surface box is hovered even
  // while the mounted content beneath is pointer-inert.
  const [hovering, setHovering] = React.useState(false);
  const stepZoom = React.useCallback(
    (direction: 1 | -1) => {
      const step = direction > 0 ? 1.1 : 1 / 1.1;
      setUserZoom((current) => {
        const base = current > 0 ? current : scale;
        return Math.min(viewTransform.max, Math.max(viewTransform.min, base * step));
      });
    },
    [scale, viewTransform],
  );
  const resetZoom = React.useCallback(() => setUserZoom(0), []);

  React.useEffect(() => {
    const node = mountRef.current;
    if (!node) return undefined;
    const mountNode = node;
    const stopHearing = hearKept(mountNode, kept => { keptByScreen.current.add(stableValueKey(kept)); });
    let cancelled = false;
    let cancelDeadline: (() => void) | null = null;
    const effectStartMs = Date.now();
    const effectLabel = sourceKey || 'source-bytes-mount';

    // T1: S4 mount effect start
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      try {
        performance.mark(`[open-path-s4-effect-start]:${effectLabel}`);
      } catch {
        // Mark failed
      }
    }

    async function mount() {
      cleanupSourceBytesScreenMount(mountNode);
      applyDataAttributes(mountNode, dataAttributes);
      setFailed(false);
      setStatus(loadingText);

      try {
        if (sourceBytes === null || sourceBytes === undefined) {
          // Null bytes mean the live read has not DELIVERED yet — loading,
          // not missing. The read scope re-renders this component the moment
          // bytes arrive (effect re-runs via sourceBytesKey). Painting
          // unavailableText immediately flashed an error before every open.
          // Only after the mount deadline passes with STILL no bytes is
          // "unavailable" the honest state.
          setStatus(loadingText);
          const deadline = window.setTimeout(() => {
            if (!cancelled) {
              setFailed(true);
              setStatus(unavailableText ?? 'This screen is taking longer than usual to open.');
            }
          }, mountTimeoutMs);
          cancelDeadline = () => window.clearTimeout(deadline);
          return;
        }
        // P5 CAS-split: Reject large inline payloads (>1MB). Force via live-source-pointer path
        // so multi-MB programs stream from CAS instead of blocking on synchronous blob transfer.
        // This prevents 6+ second timeouts on 6.3MB+ payloads. Callers with large entry-bytes
        // must pass { address_label } pointer, not Uint8Array.
        const INLINE_BYTE_THRESHOLD = 1024 * 1024; // 1MB
        if (isUint8Array(sourceBytes) && sourceBytes.byteLength > INLINE_BYTE_THRESHOLD) {
          // Dev misconfiguration (caller passed inline bytes over the limit). Log the
          // technical detail; show the human fallback (no byte counts / internals in UI).
          console.error(
            `[SourceBytesScreenMount] "${sourceKey}" entry bytes exceed inline transfer limit ` +
            `(${sourceBytes.byteLength} bytes) — caller must pass a live-source pointer (address_label).`,
          );
          setFailed(true);
          setStatus(renderFailedText('inline-byte-threshold-exceeded'));
          return;
        }
        if (!isUint8Array(sourceBytes) && !isLiveSourcePointer(sourceBytes)) {
          setStatus(unavailableText ?? 'This screen has nothing to open yet.');
          return;
        }

        const runtime = readRuntime();
        if (!runtime) {
          setStatus(runtimeUnavailableText);
          return;
        }

        const mountResult = runtime.putSourceBytesOnScreen({
          screenPlace: mountNode,
          sourceBytes,
          sourceKey,
          props: mountProps,
        });
        if (mountResult && typeof mountResult.then === 'function') {
          if (isLiveSourcePointer(sourceBytes)) {
            // A live-source POINTER is a SUBSCRIPTION, not a blocking open. The
            // painter (putSourceBytesOnScreen) installs the subscription and the
            // bytes paint progressively as the (possibly slow, cold, contended)
            // engine resolve delivers them. Its own design says never block the
            // caller's mount deadline on the first paint of a live source,
            // because that turns a slow but progressing cold-boot load into a
            // permanent dead-screen. So NEVER hard-fail a live-source mount on
            // the deadline (that hard fail is the "This screen hit a problem.
            // Timed out opening package entry bytes" dead-screen on large or
            // slow surfaces like the 1.75MB workspace-shell). Keep showing
            // loading, and after the deadline show only a soft "taking longer
            // than usual" hint, letting the subscription paint when bytes land.
            const softDeadline = window.setTimeout(() => {
              if (!cancelled) {
                setStatus(unavailableText ?? 'This screen is taking longer than usual to open.');
              }
            }, mountTimeoutMs);
            cancelDeadline = () => window.clearTimeout(softDeadline);
            try {
              await mountResult;
            } finally {
              window.clearTimeout(softDeadline);
            }
          } else {
            // Inline bytes are transferred synchronously and SHOULD be fast, so
            // a real hang here is a genuine failure worth surfacing.
            await Promise.race([
              mountResult,
              mountDeadline(mountTimeoutMs, sourceKey),
            ]);
          }
        }
        if (!cancelled) {
          // T1: S4 mount effect complete
          const effectElapsedMs = Date.now() - effectStartMs;
          if (typeof console !== 'undefined' && typeof console.log === 'function') {
            try {
              console.log(`[open-path] S4-effect mount ${effectLabel} ${effectElapsedMs}ms`);
            } catch {
              // Log failed
            }
          }
          setStatus(null);
        }
      } catch (rawError) {
        if (cancelled) return;
        const message = errorWords(rawError);
        // Surface the real failure — a swallowed mount error leaves a screen showing
        // "hit a problem" with zero diagnostic trail (0 console output). Log it so any
        // surface crash is debuggable from the console with its stack.
        console.error(
          `[SourceBytesScreenMount] mount failed for "${sourceKey}":`,
          rawError,
        );
        setFailed(true);
        setStatus(renderFailedText(message));
      }
    }

    void mount();

    return () => {
      cancelled = true;
      stopHearing();
      if (cancelDeadline) cancelDeadline();
      cleanupSourceBytesScreenMount(mountNode);
    };
  }, [
    dataAttributesKey,
    loadingText,
    mountPropsKey,
    mountTimeoutMs,
    renderFailedText,
    retryNonce,
    runtimeUnavailableText,
    sourceBytesKey,
    sourceKey,
    unavailableText,
  ]);

  return (
    <div
      ref={outerRef}
      data-source-bytes-screen-surface
      className={className}
      onWheel={onWheelZoom}
      {...(viewTransform.zoomable
        ? { onPointerEnter: () => setHovering(true), onPointerLeave: () => setHovering(false) }
        : {})}
      {...(transformStyle ? { style: { overflow: 'hidden' } } : {})}
      {...surfaceDataProps}
    >
      <div ref={mountRef} data-source-bytes-screen-mount className={mountClassName} style={transformStyle} />
      {viewTransform.zoomable && !status && (
        // Visible zoom affordance: wheel-chord zoom (Cmd/Ctrl+scroll) is
        // undiscoverable on its own, so a zoomable surface shows a small
        // hover pill. pointerEvents:auto keeps it clickable even when the
        // embedding host renders the surface pointer-inert (board tiles).
        <div
          data-surface-zoom-controls
          className="absolute bottom-2 right-2 z-10 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-opacity duration-150"
          // ALWAYS faintly visible (not hover-gated): on pointer-inert embeds
          // (board tiles) the outer box is not a hit-target, so a hover-only
          // pill could never be discovered. pointerEvents:auto makes the pill
          // itself interactive even under a pointer-events-none host class.
          onPointerEnter={() => setHovering(true)}
          onPointerLeave={() => setHovering(false)}
          style={{
            pointerEvents: 'auto',
            opacity: hovering ? 0.95 : 0.45,
            background: 'var(--glass-bg, rgba(20,20,24,0.85))',
            color: 'var(--text-primary, #eee)',
          }}
        >
          <button
            type="button"
            aria-label="Zoom out"
            onClick={(e) => { e.stopPropagation(); stepZoom(-1); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="h-5 w-5 rounded hover:bg-[var(--glass-bg-subtle,rgba(255,255,255,0.08))]"
          >
            −
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            title="Reset zoom"
            onClick={(e) => { e.stopPropagation(); resetZoom(); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="min-w-9 rounded px-1 tabular-nums hover:bg-[var(--glass-bg-subtle,rgba(255,255,255,0.08))]"
          >
            {`${Math.round(scale * 100)}%`}
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={(e) => { e.stopPropagation(); stepZoom(1); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="h-5 w-5 rounded hover:bg-[var(--glass-bg-subtle,rgba(255,255,255,0.08))]"
          >
            +
          </button>
        </div>
      )}
      {status && (
        <div
          role={failed ? 'alert' : 'status'}
          aria-live={failed ? 'assertive' : 'polite'}
          aria-busy={!failed}
          className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm bg-[var(--glass-bg-subtle)]"
          data-source-bytes-mount-status={failed ? 'failed' : 'loading'}
        >
          {/* Decouple first paint from mount: ensure status message is always visible
              even if mount times out (no blank page). A failed open shows plain-language
              copy (never the raw error / internal address — L114/L118; the technical
              detail is in the console) plus a Retry, since a large bundle can succeed on
              a second attempt once the engine thread frees. */}
          <div className="max-w-md">
            {!failed && (
              <div className="mx-auto mb-4 flex w-full max-w-xs flex-col gap-2" aria-hidden="true">
                <span className="h-3 w-2/3 rounded-full bg-[var(--glass-bg-hover)] motion-safe:animate-pulse" />
                <span className="h-3 w-full rounded-full bg-[var(--glass-bg-hover)] motion-safe:animate-pulse" />
                <span className="h-3 w-4/5 rounded-full bg-[var(--glass-bg-hover)] motion-safe:animate-pulse" />
              </div>
            )}
            <p className="text-[var(--text-primary)] font-medium">{status}</p>
            {failed && (
              <>
                <p className="text-xs text-[var(--text-secondary)] mt-3">
                  Large boards can take a moment. You can wait, or try opening it again.
                </p>
                <button
                  type="button"
                  onClick={retryMount}
                  data-source-bytes-mount-retry
                  className="mt-4 inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--glass-bg-subtle)] hover:opacity-80 transition-opacity"
                >
                  Try again
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
