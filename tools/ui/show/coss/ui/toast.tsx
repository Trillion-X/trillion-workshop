"use client";

// packages/ui/show/coss/ui/toast.tsx
//
// PURPOSE
// The one on-screen renderer for the shared notification center. Coss (MIT,
// see ../provenance.json) supplies the stacked Base UI toast geometry: cards
// collapse into a peeking stack, expand on hover or focus, swipe away and
// pause while hovered. This file draws each card from a NotificationRecord and
// keeps the Base UI toast list in step with the center's CHANGES.
//
// NON-NEGOTIABLE INVARIANTS
// 1. The notification center is the source of truth. The Base UI manager only
//    mirrors what is visible; closing a card here hides it in the center.
// 2. No kind names in this file: each card is NotificationParts' glance row, whose
//    icon, tone and ring come from DATA.
// 3. The stack is an overlay: it floats above the arranged stage (z-60, below
//    menus and dialogs) and takes no layout space. It stays at the window's
//    edge beside a docked floating control it would cover, and rises above one
//    only when there is no room beside it (keepBesideFloating).
// 4. A press on a card's body opens what it is about. Base UI captures the pointer on the card to let it swipe away, so
//    the browser's click lands on the card's root instead of the place pressed; the root hands a press that did not
//    move back to the place it went down (`pressWentTo`), so the card's own open (or a chip) answers it as it would
//    anywhere else. A drag stays a swipe.

import { Toast } from "@base-ui/react/toast";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { cn } from "../lib/utils";
import type { NotificationCenter, NotificationRecord } from "../../notifications/notification-center";
import { NotificationRow, notificationKindAppearance, notificationListing } from "../../notifications/NotificationParts";
import { keepBesideFloating } from "../../floating-occlusion/keep-beside-floating";

type SwipeDirection = "up" | "down" | "left" | "right";
type ToastData = { record: NotificationRecord };

export type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

function getSwipeDirection(position: ToastPosition): SwipeDirection[] {
  const verticalDirection: SwipeDirection = position.startsWith("top") ? "up" : "down";
  if (position.includes("center")) return [verticalDirection];
  if (position.includes("left")) return ["left", verticalDirection];
  return ["right", verticalDirection];
}

export const toastManager: ReturnType<typeof Toast.createToastManager<ToastData>> =
  Toast.createToastManager<ToastData>();

/** Mirror the center's visible records into the Base UI toast list. O(changed). */
function useMirrorCenter(center: NotificationCenter): void {
  useEffect(() => {
    // Each card's timeout as last given: Base UI restarts a card's timer whenever an update names a timeout, so an
    // update names one only when it changed. Otherwise a card re-emitted on every store change would never leave.
    const shown = new Map<string, number>();
    // The words a screen reader announces are the row's own words, through the same failure-words gate the row draws.
    const options = (record: NotificationRecord) => ({
      title: notificationListing(record).title,
      type: record.kind,
      priority: notificationKindAppearance(record.kind).tone === "red" ? ("high" as const) : ("low" as const),
      data: { record },
    });
    const show = (record: NotificationRecord) => {
      if (shown.has(record.id)) {
        const timeoutChanged = shown.get(record.id) !== record.timeout;
        shown.set(record.id, record.timeout);
        toastManager.update(record.id, { ...options(record), ...(timeoutChanged ? { timeout: record.timeout } : {}) });
        return;
      }
      shown.set(record.id, record.timeout);
      toastManager.add({
        id: record.id,
        ...options(record),
        timeout: record.timeout,
        onClose: () => center.hide(record.id),
        onRemove: () => shown.delete(record.id),
      });
    };
    // What the center already shows when the stack mounts (a notice raised before the stack's code arrived) is added
    // once the commit's effects have run: Base UI's provider, the parent, starts listening to the manager after this
    // child's effect, and a card added before then is lost.
    queueMicrotask(() => { for (const record of [...center.visible()].reverse()) if (!shown.has(record.id)) show(record); });
    return center.subscribe((change) => {
      const { record } = change;
      if (change.type === "hidden" || change.type === "removed") {
        if (shown.has(record.id)) toastManager.close(record.id);
        return;
      }
      if (record.visible) show(record);
    });
  }, [center]);
}

/** How far a press may move and still be a press, not a swipe (px). */
const PRESS_SLOP = 6;

/** Gives a toast's click back to where the press went down (invariant 4): pointer capture for the swipe sends it to the
 *  card's root, and a press that did not move is handed to the nearest thing there that answers a click. */
function usePressWentTo() {
  const down = useRef<{ target: Element; x: number; y: number } | null>(null);
  return {
    onPointerDownCapture: (event: React.PointerEvent) => {
      down.current = event.button === 0 && event.target instanceof Element ? { target: event.target, x: event.clientX, y: event.clientY } : null;
    },
    onClick: (event: React.MouseEvent) => {
      const pressed = down.current;
      down.current = null;
      if (!pressed || event.target !== event.currentTarget || !event.currentTarget.contains(pressed.target)) return;
      if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > PRESS_SLOP) return;
      const answers = pressed.target.closest("button, a, [role='link'], [data-slot='listing-card'][data-opens]");
      if (answers instanceof HTMLElement && event.currentTarget.contains(answers)) answers.click();
    },
  };
}

function NotificationCard({ record }: { record: NotificationRecord }): React.ReactElement {
  const tone = notificationKindAppearance(record.kind).tone;
  return (
    <Toast.Content
      className="notification-card pointer-events-auto transition-opacity duration-250 data-behind:not-data-expanded:pointer-events-none data-behind:opacity-0 data-expanded:opacity-100"
      data-slot="notification-card" data-tone={tone} data-running={record.running || undefined}>
      <Toast.Title className="sr-only" data-slot="toast-title" />
      <NotificationRow record={record} onDismiss={() => toastManager.close(record.id)}
        controls={(
          <Toast.Close className="notification-dismiss" data-slot="notification-dismiss" aria-label="Dismiss notification">
            <XIcon aria-hidden="true" />
          </Toast.Close>
        )} />
    </Toast.Content>
  );
}

function Toasts({
  position,
  portalProps,
}: {
  position: ToastPosition;
  portalProps?: React.ComponentProps<typeof Toast.Portal>;
}): React.ReactElement {
  const { toasts } = Toast.useToastManager<ToastData>();
  const swipeDirection = getSwipeDirection(position);
  // The portal draws the viewport after this first renders, so it is kept from the moment it exists, not from mount.
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  useEffect(() => (viewport ? keepBesideFloating(viewport) : undefined), [viewport]);

  return (
    <Toast.Portal data-slot="toast-portal" {...portalProps}>
      <Toast.Viewport
        ref={setViewport}
        className={cn(
          "fixed z-60 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-96 [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          "data-[position*=top]:top-(--toast-inset)",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:left-1/2 data-[position*=center]:-translate-x-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
      >
        {toasts.map((toast) => {
          const record = toast.data?.record;
          if (!record) return null;
          return (
            <PressableToastRoot
              key={toast.id}
              className={cn(
                "absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) w-full select-none rounded-lg border bg-[color-mix(in_srgb,var(--popover),var(--color-black)_calc(1%*max(0,var(--toast-index,0))))] not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s,background-color_.5s] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-expanded:bg-popover dark:bg-[color-mix(in_srgb,var(--popover),var(--color-black)_calc(6%*max(0,var(--toast-index,0))))] dark:data-expanded:bg-popover dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
                // Base positioning using data-position
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-[50%_calc(50%-50%*min(var(--toast-index,0),1))]",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-[50%_calc(50%+50%*min(var(--toast-index,0),1))]",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                // Define some variables
                "[--toast-calc-height:var(--toast-frontmost-height,var(--toast-height))] [--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Define offset-y variable
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                // Default state transform
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                // Limited state
                "data-limited:opacity-0",
                // Expanded state
                "data-expanded:h-(--toast-height)",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                // Starting and ending animations
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-ending-style:opacity-0",
                // Ending animations (direction-aware)
                "data-[position*=top]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Ending animations (expanded)
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                "notification-root",
              )}
              data-position={position}
              data-tone={notificationKindAppearance(record.kind).tone}
              data-revision={record.revision}
              swipeDirection={swipeDirection}
              toast={toast}
            >
              <NotificationCard record={record} />
            </PressableToastRoot>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

/** A toast's root whose click goes back to where the press went down (invariant 4). */
function PressableToastRoot(props: React.ComponentProps<typeof Toast.Root>): React.ReactElement {
  const press = usePressWentTo();
  return <Toast.Root {...props} onPointerDownCapture={press.onPointerDownCapture} onClick={press.onClick} />;
}

export interface ToastProviderProps extends Toast.Provider.Props {
  center: NotificationCenter;
  position?: ToastPosition;
  portalProps?: React.ComponentProps<typeof Toast.Portal>;
}

function CenterMirror({ center }: { center: NotificationCenter }): null {
  useMirrorCenter(center);
  return null;
}

export function ToastProvider({
  children,
  center,
  position = "bottom-right",
  portalProps,
  ...props
}: ToastProviderProps): React.ReactElement {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      <CenterMirror center={center} />
      {children}
      <Toasts portalProps={portalProps} position={position} />
    </Toast.Provider>
  );
}

export { Toast as ToastPrimitive };
