// packages/public-scene-share/show/ShareAffordance.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The REAL, mountable Share button — the product surface for the proven capsule
// pipeline. It renders the human view-model from `share-scene-presenter`
// (idle → minting → shared/error) on shared `ui/` components, and drives the
// lifecycle by calling an INJECTED `onMint()` (the live `create-capsule` target).
//
// =============================================================================
// HOW IT STAYS GENERIC + DECOUPLED (L098)
// =============================================================================
// • It owns ZERO scene/engine knowledge. The live mint is injected (`onMint`);
//   in-app the caller injects the `create-capsule` target dispatch, the browser
//   proof injects a local mint — identical component, identical tested copy.
// • Copy-to-clipboard is injected (`copyUrl`, default `navigator.clipboard`), so
//   the component is testable under jsdom with no platform clipboard.
// • Human copy comes ENTIRELY from the presenter (no literal strings here that a
//   product would localize) — the presenter is the SSOT for share wording.
// =============================================================================

import React from 'react';
import { Button, Card, Container, Text, Icon } from '@/packages/ui';
import { Share2, Copy, Check, Loader2 } from 'lucide-react';
import {
  idleShareView,
  mintingShareView,
  unreachableShareView,
  shareViewFromReply,
  type CapsuleReply,
  type ShareConfig,
  type ShareView,
} from '@/packages/public-scene-share/show/share-scene-presenter';

export interface ShareAffordanceProps {
  /** DATA — the public origin the minted link points at (local for preview). */
  readonly config: ShareConfig;
  /** Injected live mint: dispatches `public-scene-share.create-capsule`. */
  readonly onMint: () => Promise<CapsuleReply>;
  /** Injected clipboard write (default `navigator.clipboard.writeText`). */
  readonly copyUrl?: (url: string) => Promise<void>;
}

async function defaultCopy(url: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(url);
}

export function ShareAffordance({ config, onMint, copyUrl = defaultCopy }: ShareAffordanceProps) {
  // No deploy target connected -> the honest "unreachable" state up front, before any
  // mint is even attempted. Re-evaluated whenever `config` changes (e.g. a deploy
  // target gets connected mid-session and a fresh origin becomes reachable) so the
  // button recovers without requiring a remount (L114/L116).
  const [view, setView] = React.useState<ShareView>(() =>
    config.isPubliclyReachable === false ? unreachableShareView() : idleShareView(),
  );
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setView((prev) => {
      if (prev.status === 'minting' || prev.status === 'shared') return prev; // don't clobber an in-flight or settled mint
      return config.isPubliclyReachable === false ? unreachableShareView() : idleShareView();
    });
  }, [config.isPubliclyReachable]);

  const share = React.useCallback(async () => {
    if (config.isPubliclyReachable === false) {
      setView(unreachableShareView());
      return;
    }
    setCopied(false);
    setView(mintingShareView());
    try {
      const reply = await onMint();
      setView(shareViewFromReply(reply, config));
    } catch (e) {
      setView(shareViewFromReply({ ok: false, reason: e instanceof Error ? e.message : String(e) }, config));
    }
  }, [onMint, config]);

  const copy = React.useCallback(async () => {
    if (!view.shareUrl) return;
    try {
      await copyUrl(view.shareUrl);
      setCopied(true);
    } catch {
      /* clipboard denied — leave the visible URL so the user can copy manually */
    }
  }, [view.shareUrl, copyUrl]);

  const PrimaryIcon = view.busy ? Loader2 : view.canCopy ? (copied ? Check : Copy) : Share2;

  return (
    <Card variant="elevated" padding="md" data-share-affordance>
      <Container layout="vertical" gap="sm">
        <Button
          variant={view.status === 'error' || view.status === 'unreachable' ? 'secondary' : 'primary'}
          size="sm"
          disabled={view.busy || view.status === 'unreachable'}
          onClick={view.canCopy ? copy : share}
          aria-label={view.primaryLabel}
          data-share-primary
        >
          <Icon icon={PrimaryIcon} size="sm" /> {copied && view.canCopy ? 'Copied' : view.primaryLabel}
        </Button>
        {view.shareUrl ? (
          <Text variant="body-xs" color="accent" data-share-url>{view.shareUrl}</Text>
        ) : null}
        {view.helpText ? (
          <Text variant="body-xs" color={view.status === 'error' ? 'danger' : 'muted'}>{view.helpText}</Text>
        ) : null}
      </Container>
    </Card>
  );
}
