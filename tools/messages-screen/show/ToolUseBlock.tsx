// PORTED FROM: bitfield-packages/packages/chat/show/ToolUseBlock.tsx @ e99ac5976
// Product Chat renders the effect of tool-backed work without exposing model,
// command, parameter, hook, token, timing, path, or diagnostic details.

import React, { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { ToolUseInfo } from '../read-data/chat-message-types';
import { Badge, Button, Card, Container, Icon, Text } from '../../ui';
import type { StatusDotProps } from '../../ui';
import type { PlaceableSurfacePayload } from '../../ui/show/placeable-surface-intent';
import { PlaceableSurfaceHost } from '../../ui/show/placeable-surface-host';
import { surfaceIntentMatchesCatalogPayload } from '../../ui/show/placeable-surface-intent';
import { emitPlaceableSurfaceIntent, readPlaceableSurfacePayloadFromUnknown } from '../../ui/show/placeable-surface-intent';
import {
  emitReceiptSurfaceIntent,
  receiptSurfaceIntentRequest,
} from './receipt-surface-intent';
import {
  findToolResultSurface,
  readToolResultSurfaceSummary,
  toolResultSurfaceWithRows,
} from '../read-data/read-tool-result-surface-card';
import { ToolResultSurfaceCard } from './ToolResultSurfaceCard';
import { plainChatError } from './ChatErrorBanner';

// These formatters remain exported because non-product diagnostic consumers use
// them. ToolUseBlock itself never paints their output in a conversation.
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

export function formatElapsed(startedAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.floor(secs % 60);
  if (mins < 60) return `${mins}m ${remSecs}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function getStatusDotStatus(status: string): NonNullable<StatusDotProps['status']> {
  switch (status) {
    case 'active': return 'success';
    case 'starting': return 'warning';
    case 'error': return 'error';
    default: return 'idle';
  }
}

export interface ToolUseBlockProps {
  toolUse: ToolUseInfo;
  defaultOpen?: boolean;
  durationMs?: number;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  isStreaming?: boolean;
  placeableSurfaceCatalog?: readonly PlaceableSurfacePayload[];
  surfaceIntentDestinationRef?: string | null;
}

function isErrorResult(result: string | undefined): boolean {
  return !!result && /^(?:error|failed|failure)\b/i.test(result.trim());
}

export function ToolUseBlock({
  toolUse,
  isStreaming = false,
  placeableSurfaceCatalog = [],
  surfaceIntentDestinationRef = null,
}: ToolUseBlockProps) {
  const [openError, setOpenError] = useState<string | null>(null);
  const resultIsError = isErrorResult(toolUse.result);
  const surface = readPlaceableSurfacePayloadFromUnknown(toolUse.placeableResult?.surface);
  const eligibleSurface = !!surface && surfaceIntentMatchesCatalogPayload(surface, placeableSurfaceCatalog);
  const placementRequest = eligibleSurface
    ? receiptSurfaceIntentRequest(toolUse.placeableResult, surfaceIntentDestinationRef)
    : null;
  const summary = readToolResultSurfaceSummary(toolUse.placeableResult?.surface);
  const surfaceCard = findToolResultSurface(summary, placeableSurfaceCatalog);
  const surfaceCardTitle = surfaceCard
    ? ('label' in surfaceCard && typeof surfaceCard.label === 'string' && surfaceCard.label.trim()
      ? surfaceCard.label.trim()
      : surfaceCard.title || 'Results')
    : 'Results';

  return (
    <Card variant={resultIsError ? 'error' : 'nested'} padding="sm">
      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm" alignItems="center">
          {resultIsError ? <Icon icon={AlertCircle} size="sm" color="error" /> : null}
          <Badge variant={resultIsError ? 'error' : 'muted'} size="sm">
            {isStreaming ? 'Your assistant is working' : resultIsError ? 'Action failed' : 'Work complete'}
          </Badge>
        </Container>

        {resultIsError ? (
          <Text variant="body-xs" color="error">{plainChatError(toolUse.result || '')}</Text>
        ) : null}

        {!resultIsError && eligibleSurface && surface?.packageEntry ? (
          <PlaceableSurfaceHost
            packageName={surface.packageEntry.packageName}
            entryName={surface.packageEntry.entryName}
            target={surface.target}
            surfaceInput={surface.surfaceInput}
            fill
          />
        ) : null}

        {!resultIsError && summary && surfaceCard ? (
          <ToolResultSurfaceCard
            toolLabel="Assistant"
            surfaceTitle={surfaceCardTitle}
            summary={summary}
            openError={openError}
            onOpen={() => {
              const accepted = emitPlaceableSurfaceIntent(toolResultSurfaceWithRows(surfaceCard, summary));
              setOpenError(accepted ? null : 'These results could not open. Try again.');
            }}
          />
        ) : null}

        {!resultIsError && placementRequest ? (
          <Container layout="horizontal" gap="xs" alignItems="center">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const accepted = emitReceiptSurfaceIntent(toolUse.placeableResult, surfaceIntentDestinationRef);
                setOpenError(accepted ? null : 'These results could not open. Try again.');
              }}
            >
              Open in workspace
            </Button>
            {openError ? <Text variant="body-xs" color="error">{openError}</Text> : null}
          </Container>
        ) : null}
      </Container>
    </Card>
  );
}
