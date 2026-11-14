// Browser-local recipient for addressed surface intents. It subscribes only to
// requests named for its opaque destination and delegates validation, routing,
// and acknowledgement to the existing AddressedSurfaceIntentReader.

import * as React from 'react';

import {
  PLACEABLE_SURFACE_MIME,
  readPlaceableSurfacePayloadFromUnknown,
  readAddressedSurfaceIntentRequest,
  type PlaceableSurfacePayload,
  type AddressedSurfaceIntentRequest,
} from './placeable-surface-intent';
import {
  AddressedSurfaceIntentReader,
  type AddressedSurfaceIntentReaderProps,
} from './addressed-surface-intent-reader';

type RecipientProps = Omit<AddressedSurfaceIntentReaderProps, 'source' | 'intentPath' | 'keyPath' | 'dispositionRoutes' | 'defaultRoute' | 'emit'> & {
  readonly destinationRef: string;
  /** Owner acknowledgement: true only after its durable/idempotent mutation. */
  readonly emit: (payload: Parameters<NonNullable<AddressedSurfaceIntentReaderProps['emit']>>[0], deliveryRef: string) => boolean | Promise<boolean>;
};

/** Caller-owned identity makes receiver dedup independent of source shape. */
export function addressedSurfaceIntentDeliveryKey(request: AddressedSurfaceIntentRequest): string {
  return `${request.destinationRef}\u0000${request.deliveryRef}`;
}

type QueuedRequest = { readonly key: string; readonly request: AddressedSurfaceIntentRequest };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readDirectPayloadForDestination(
  value: unknown,
  destinationRef: string,
): PlaceableSurfacePayload | null {
  const payload = readPlaceableSurfacePayloadFromUnknown(value);
  if (!payload) return null;
  const surfaceInput = isRecord(payload.surfaceInput) ? { ...payload.surfaceInput } : null;
  if (!surfaceInput || surfaceInput.surface_intent_destination_ref !== destinationRef) return null;
  delete surfaceInput.surface_intent_destination_ref;
  return {
    ...payload,
    ...(Object.keys(surfaceInput).length > 0 ? { surfaceInput } : {}),
  };
}

export function AddressedSurfaceIntentRecipient({
  destinationRef,
  emit,
  ...props
}: RecipientProps): React.ReactElement | null {
  const [request, setRequest] = React.useState<QueuedRequest | null>(null);
  const pending = React.useRef<string | null>(null);
  const destination = destinationRef.trim();

  React.useEffect(() => {
    // A destination identity change retires the old browser-local request.
    // Durable receipt and owner state remain available for explicit replay.
    pending.current = null;
    setRequest(null);
    if (!destination) return;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const directPayload = readDirectPayloadForDestination(detail, destination);
      if (directPayload) {
        if (props.permit && !props.permit(directPayload, props.allowList)) return;
        event.preventDefault();
        void emit(directPayload, `${destination}\u0000direct`);
        return;
      }
      const request = readAddressedSurfaceIntentRequest(detail);
      if (!request || request.destinationRef !== destination) return;
      const key = addressedSurfaceIntentDeliveryKey(request);
      if (pending.current === key) {
        // The same caller-owned delivery is already being evaluated or written.
        event.preventDefault();
        return;
      }
      // One destination owns one serialized mutation stream. Backpressure is
      // explicit: a different concurrent request stays unaccepted and its
      // producer may retry. This browser subscriber is never a queue or ledger.
      if (pending.current !== null) return;
      pending.current = key;
      setRequest({ key, request });
      // A matching recipient owns this browser-local subscription. A wrong or
      // absent destination never reaches this point and remains unaccepted.
      event.preventDefault();
    };
    window.addEventListener(PLACEABLE_SURFACE_MIME, receive);
    return () => window.removeEventListener(PLACEABLE_SURFACE_MIME, receive);
  }, [destination, emit, props.allowList, props.permit]);

  if (!request) return null;
  const { key, request: activeRequest } = request;
  const settle = () => {
    if (pending.current !== key) return;
    pending.current = null;
    setRequest((current) => current?.key === key ? null : current);
  };
  return (
    <AddressedSurfaceIntentReader
      key={key}
      {...props}
      source={activeRequest.source}
      intentPath={activeRequest.intentPath}
      keyPath={activeRequest.keyPath}
      dispositionRoutes={activeRequest.dispositionRoutes}
      defaultRoute={activeRequest.defaultRoute}
      emit={(payload) => emit(payload, activeRequest.deliveryRef)}
      onSettled={settle}
    />
  );
}
