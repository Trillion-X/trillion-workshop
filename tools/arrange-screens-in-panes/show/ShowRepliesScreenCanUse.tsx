// packages/screen-arrangement/show/ShowRepliesScreenCanUse.tsx
//
// Browser-society mount point for screen surface reply bytes. This file is not
// a feature registry: it asks one target address and mounts only generic browser
// element replies this screen can understand.

import React from 'react';
import {
  askDiscoveredAddress,
  type DiscoveredAddressReply,
} from '../do-work/ask-discovered-addresses';
import {
  findDiscoveredAddressForTarget,
  type PublishedRecord,
} from '../read-data/read-published-records';

export interface ShowRepliesScreenCanUseProps {
  target: string | null;
  requestPayload: unknown;
  publishedRecords: readonly PublishedRecord[];
  missing: React.ReactNode;
  className?: string;
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
  if (!isBytes(payload)) return payload;
  const text = textDecoder.decode(payload).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
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

function buildChildren(value: unknown): React.ReactNode {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    return value.map((child, index) => (
      <React.Fragment key={index}>{buildChildren(child)}</React.Fragment>
    ));
  }
  return mountReplyThisScreenCanUse(value);
}

export function mountReplyThisScreenCanUse(reply: unknown): React.ReactNode | null {
  if (React.isValidElement(reply)) return reply;
  const decoded = decodeReplyPayload(reply);
  if (React.isValidElement(decoded)) return decoded;

  const spec = readElementSpec(decoded);
  if (!isRecord(spec)) return null;

  const type = readElementType(spec);
  if (!type) return null;

  const props = Object.fromEntries(
    Object.entries(readProps(spec))
      .map(([key, value]) => [key, sanitizePropValue(value)] as const)
      .filter(([, value]) => value !== undefined),
  );

  return React.createElement(type, props, buildChildren(readChildren(spec)));
}

export function ShowRepliesScreenCanUse({
  target,
  requestPayload,
  publishedRecords,
  missing,
  className,
}: ShowRepliesScreenCanUseProps) {
  const discovered = React.useMemo(
    () => {
      if (!target) return null;
      return findDiscoveredAddressForTarget(publishedRecords, target) ?? {
        target,
        recordId: target,
        sourcePath: 'screen-arrangement.tab.target',
        payload: { target },
      };
    },
    [publishedRecords, target],
  );
  const [reply, setReply] = React.useState<DiscoveredAddressReply | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setReply(null);
    if (!discovered) return () => {
      cancelled = true;
    };

    askDiscoveredAddress(discovered, requestPayload).then((nextReply) => {
      if (!cancelled) setReply(nextReply);
    });

    return () => {
      cancelled = true;
    };
  }, [discovered, requestPayload]);

  const node = reply && !reply.error ? mountReplyThisScreenCanUse(reply.reply) : null;
  if (!node) {
    return (
      <div
        className={className}
        data-screen-reply-state={!target ? 'no-target' : discovered ? 'no-usable-reply' : 'target-not-discovered'}
        data-screen-reply-target={target ?? ''}
      >
        {missing}
      </div>
    );
  }

  return (
    <div
      className={className}
      data-screen-reply-state="usable-reply"
      data-screen-reply-target={reply.target}
      data-screen-reply-duration-ms={reply.durationMs.toFixed(3)}
    >
      {node}
    </div>
  );
}
