"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import * as React from "react";
import { cn } from "../lib/utils";
import { LAYER_ORDER } from "../../layer-order/layer-order";
import { PhoneSheetGrip, phoneSheetPositioner, phoneSheetSurface, usePhoneSheet } from "../../phone-sheet/phone-sheet";

export const PopoverCreateHandle: typeof PopoverPrimitive.createHandle =
  PopoverPrimitive.createHandle;

// A popover that opens when pointed at stays open when its trigger is then pressed: the press pins it (it no longer
// closes when the pointer leaves) instead of toggling it shut, so pointing and then clicking never looks like nothing
// happened. Base UI only keeps it for a press within 500 ms of the hover opening it; this holds for any press. A pinned
// popover closes on Escape, a press outside, a press on its trigger again or its own close.
function PopoverRoot(props: PopoverPrimitive.Root.Props): React.ReactElement {
  const { onOpenChange } = props;
  const opened = React.useRef<{ byHover: boolean; pinned: boolean }>({ byHover: false, pinned: false });
  const handleOpenChange = React.useCallback<NonNullable<PopoverPrimitive.Root.Props["onOpenChange"]>>((open, details) => {
    const state = opened.current;
    if (open) {
      state.byHover = details.reason === REASON_HOVER;
      state.pinned = details.reason === REASON_PRESS;
    } else if (details.reason === REASON_PRESS && state.byHover && !state.pinned) {
      state.pinned = true;
      details.cancel();
      return;
    } else if (details.reason === REASON_HOVER && state.pinned) {
      details.cancel();
      return;
    } else {
      state.byHover = false;
      state.pinned = false;
    }
    onOpenChange?.(open, details);
  }, [onOpenChange]);
  return <PopoverPrimitive.Root {...props} onOpenChange={handleOpenChange} />;
}
const REASON_HOVER = "trigger-hover";
const REASON_PRESS = "trigger-press";

export const Popover = PopoverRoot as typeof PopoverPrimitive.Root;

export function PopoverTrigger({
  className,
  children,
  ...props
}: PopoverPrimitive.Trigger.Props): React.ReactElement {
  return (
    <PopoverPrimitive.Trigger
      className={className}
      data-slot="popover-trigger"
      {...props}
    >
      {children}
    </PopoverPrimitive.Trigger>
  );
}

export function PopoverPopup({
  children,
  className,
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  tooltipStyle = false,
  anchor,
  portalProps,
  preserveContent = false,
  ...props
}: PopoverPrimitive.Popup.Props & {
  portalProps?: PopoverPrimitive.Portal.Props;
  /** Stateful single-trigger forms can retain their children across closing.
   *  Pair with portalProps.keepMounted; animated trigger switching remounts its viewport. */
  preserveContent?: boolean;
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  tooltipStyle?: boolean;
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
}): React.ReactElement {
  // On a phone the popover is a sheet at the bottom edge (phone-sheet), except a tooltip-sized note, which stays by its control.
  const sheet = usePhoneSheet() && !tooltipStyle;
  return (
    <PopoverPrimitive.Portal {...portalProps}>
      {sheet ? <PopoverPrimitive.Backdrop className="phone-sheet-backdrop" style={{ zIndex: LAYER_ORDER.menu }} /> : null}
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
        data-slot="popover-positioner"
        // Opened by the person, so above every floating window it opens from.
        style={{ zIndex: LAYER_ORDER.menu }}
        side={side}
        sideOffset={sideOffset}
        {...phoneSheetPositioner(sheet)}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 outline-none transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] has-data-[slot=calendar]:rounded-xl has-data-[slot=calendar]:before:rounded-[calc(var(--radius-xl)-1px)] data-starting-style:scale-98 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            tooltipStyle &&
              "w-fit text-balance rounded-md text-xs shadow-md/5 before:rounded-[calc(var(--radius-md)-1px)]",
            className,
          )}
          data-slot="popover-popup"
          data-tooltip-style={tooltipStyle ? "" : undefined}
          {...props}
          {...phoneSheetSurface(sheet)}
        >
          {sheet ? <PhoneSheetGrip /> : null}
          {preserveContent ? <div className="relative size-full max-h-(--available-height) overflow-y-auto px-4 py-4" data-slot="popover-viewport">
            {children}
          </div> : <PopoverPrimitive.Viewport
            className={cn(
              "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) py-4 [--viewport-inline-padding:--spacing(4)] has-data-[slot=calendar]:p-2 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
              tooltipStyle
                ? "py-1 [--viewport-inline-padding:--spacing(2)]"
                : "not-data-transitioning:overflow-y-auto",
            )}
            data-slot="popover-viewport"
          >
            {children}
          </PopoverPrimitive.Viewport>}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export function PopoverClose({
  ...props
}: PopoverPrimitive.Close.Props): React.ReactElement {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

export function PopoverTitle({
  className,
  ...props
}: PopoverPrimitive.Title.Props): React.ReactElement {
  return (
    <PopoverPrimitive.Title
      className={cn("font-semibold text-lg leading-none", className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

export function PopoverDescription({
  className,
  ...props
}: PopoverPrimitive.Description.Props): React.ReactElement {
  return (
    <PopoverPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="popover-description"
      {...props}
    />
  );
}

export { PopoverPrimitive, PopoverPopup as PopoverContent };
