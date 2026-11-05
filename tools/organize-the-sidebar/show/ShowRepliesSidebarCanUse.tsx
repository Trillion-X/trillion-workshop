// packages/sidebar/show/ShowRepliesSidebarCanUse.tsx
//
// Browser-society mount point for reply bytes. It asks the current scoped target
// set and shows only replies this browser surface can understand.

import React, { useEffect, useMemo, useState } from 'react';
import { useBitfieldData } from '#workspace-records';

import {
  askDiscoveredAddresses,
  type DiscoveredAddressReply,
} from '../do-work/ask-discovered-addresses.ts';
import {
  findDiscoveredAddresses,
  normalizeFeedRows,
  readPublishedRecords,
} from '../read-data/read-published-records.ts';

export type ReplyActionHandler = (event: React.SyntheticEvent<HTMLElement>) => void;
export type ReplyActionHandlers = Record<string, ReplyActionHandler | undefined>;

export interface ShowRepliesSidebarCanUseProps {
  requestPayload: unknown;
  missing: React.ReactNode;
  actions?: ReplyActionHandlers;
  requiredActions?: readonly string[];
  className?: string;
  maxTargets?: number;
}

const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array');
}

function decodeReplyPayload(reply: unknown): unknown {
  const payload = isRecord(reply) && isBytes(reply.payload) ? reply.payload : reply;
  if (isBytes(payload)) {
    const text = textDecoder.decode(payload).trim();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return payload;
}

function readElementSpec(decoded: unknown): unknown {
  if (!isRecord(decoded)) return null;
  return decoded.browser_react_element ?? decoded.web_component ?? decoded.browser_element ?? null;
}

function readElementType(spec: Record<string, unknown>): string | null {
  const type = spec.type ?? spec.tag;
  return typeof type === 'string' && type.length > 0 ? type : null;
}

function readProps(spec: Record<string, unknown>): Record<string, unknown> {
  const rawProps = spec.props ?? spec.attributes;
  return isRecord(rawProps) ? rawProps : {};
}

function readEventMap(spec: Record<string, unknown>): Record<string, string> {
  const rawEvents = spec.events ?? spec.event_handlers;
  if (!isRecord(rawEvents)) return {};
  return Object.fromEntries(
    Object.entries(rawEvents).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function readChildren(spec: Record<string, unknown>): unknown {
  return spec.children ?? spec.child ?? spec.text ?? null;
}

function sanitizePropValue(value: unknown): unknown {
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizePropValue);
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, child]) => [key, sanitizePropValue(child)] as const)
      .filter(([, child]) => child !== undefined),
  );
}

function buildProps(
  rawProps: Record<string, unknown>,
  eventMap: Record<string, string>,
  actions: ReplyActionHandlers,
): { props: Record<string, unknown>; bridgedActions: Set<string> } {
  const props: Record<string, unknown> = {};
  const bridgedActions = new Set<string>();
  for (const [key, value] of Object.entries(rawProps)) {
    if (key.startsWith('on')) continue;
    const sanitized = key === 'style' && isRecord(value) ? value : sanitizePropValue(value);
    if (sanitized !== undefined) props[key] = sanitized;
  }

  for (const [eventName, actionName] of Object.entries(eventMap)) {
    const handler = actions[actionName];
    if (!handler) continue;
    const reactEventName = eventName.startsWith('on')
      ? eventName
      : `on${eventName.slice(0, 1).toUpperCase()}${eventName.slice(1)}`;
    props[reactEventName] = handler;
    bridgedActions.add(actionName);
  }

  return { props, bridgedActions };
}

function buildChildren(value: unknown, actions: ReplyActionHandlers): React.ReactNode {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map((child, index) => (
    <React.Fragment key={index}>{buildChildren(child, actions)}</React.Fragment>
  ));
  return mountReplyThisSurfaceCanUse(value, actions);
}

export function mountReplyThisSurfaceCanUse(
  reply: unknown,
  actions: ReplyActionHandlers = {},
): React.ReactNode | null {
  return mountReplyThisSurfaceCanUseWithMetadata(reply, actions).node;
}

function mountReplyThisSurfaceCanUseWithMetadata(
  reply: unknown,
  actions: ReplyActionHandlers = {},
): { node: React.ReactNode | null; bridgedActions: Set<string> } {
  if (React.isValidElement(reply)) return { node: reply, bridgedActions: new Set() };

  const decoded = decodeReplyPayload(reply);
  if (React.isValidElement(decoded)) return { node: decoded, bridgedActions: new Set() };

  const spec = readElementSpec(decoded);
  if (!isRecord(spec)) return { node: null, bridgedActions: new Set() };

  const type = readElementType(spec);
  if (!type) return { node: null, bridgedActions: new Set() };

  const { props, bridgedActions } = buildProps(readProps(spec), readEventMap(spec), actions);
  return {
    node: React.createElement(type, props, buildChildren(readChildren(spec), actions)),
    bridgedActions,
  };
}

export function ShowRepliesSidebarCanUse({
  requestPayload,
  missing,
  actions = {},
  requiredActions = [],
  className,
  maxTargets = 8,
}: ShowRepliesSidebarCanUseProps) {
  // Scoped feed of self-describing reply-template records (kind:"reply-template"),
  // engine-maintained from the same fold — NOT the multi-MB published-records
  // aggregate. Same {address,payload} cell_table projection, so the shared
  // reader is unchanged; sidebar no longer re-materializes 34.7MB per open.
  const recordsEntry = useBitfieldData('reply-provider-feed');
  const records = useMemo(
    () => readPublishedRecords(normalizeFeedRows(recordsEntry)),
    [recordsEntry],
  );
  const targets = useMemo(
    () => findDiscoveredAddresses(records).slice(0, maxTargets),
    [maxTargets, records],
  );
  const [replies, setReplies] = useState<DiscoveredAddressReply[]>([]);

  useEffect(() => {
    let cancelled = false;
    setReplies([]);
    if (targets.length === 0) return () => {
      cancelled = true;
    };

    askDiscoveredAddresses(targets, requestPayload).then((nextReplies) => {
      if (!cancelled) setReplies(nextReplies);
    });

    return () => {
      cancelled = true;
    };
  }, [requestPayload, targets]);

  const usableReplies = replies
    .map((reply) => {
      const mounted = reply.error
        ? { node: null, bridgedActions: new Set<string>() }
        : mountReplyThisSurfaceCanUseWithMetadata(reply.reply, actions);
      const hasRequiredActions = requiredActions.every((actionName) => mounted.bridgedActions.has(actionName));
      return {
        ...reply,
        node: hasRequiredActions ? mounted.node : null,
      };
    })
    .filter((reply): reply is DiscoveredAddressReply & { node: React.ReactNode } => reply.node != null);

  if (usableReplies.length === 0) {
    return (
      <span
        className={className}
        data-use-replies-state={targets.length === 0 ? 'no-discovered-addresses' : 'no-usable-replies'}
        data-use-replies-targets={targets.map((target) => target.target).join(',')}
      >
        {missing}
      </span>
    );
  }

  return (
    <span
      className={className}
      data-use-replies-state="usable-replies"
      data-use-replies-targets={usableReplies.map((reply) => reply.target).join(',')}
      data-use-replies-duration-ms={usableReplies.map((reply) => reply.durationMs.toFixed(3)).join(',')}
    >
      {usableReplies.map((reply) => (
        <React.Fragment key={`${reply.target}:${reply.recordId}`}>{reply.node}</React.Fragment>
      ))}
    </span>
  );
}
