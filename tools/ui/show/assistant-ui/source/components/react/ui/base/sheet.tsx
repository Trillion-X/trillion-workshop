"use client";

// Adapted from assistant-ui's base Sheet (MIT). Upstream slides a Base UI
// modal panel in from a screen edge over a dimming backdrop. Here a sheet is
// the same shared floating panel as a dialog: a movable, resizable window
// beside the page, with no backdrop, no aria-modal and no focus trap. One
// implementation serves both names.

import * as React from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

type SheetProps = React.ComponentProps<typeof Dialog> & Record<string, unknown>;

function Sheet({ open, defaultOpen, onOpenChange, children }: SheetProps) {
  return (
    <Dialog open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {children}
    </Dialog>
  );
}

function SheetContent({
  side: _side,
  ...props
}: React.ComponentProps<typeof DialogContent> & {
  /** Upstream edge placement; the floating panel opens against its trigger instead. */
  side?: "top" | "right" | "bottom" | "left";
}) {
  return <DialogContent width={320} {...props} />;
}

export {
  Sheet,
  DialogTrigger as SheetTrigger,
  DialogClose as SheetClose,
  SheetContent,
  DialogHeader as SheetHeader,
  DialogFooter as SheetFooter,
  DialogTitle as SheetTitle,
  DialogDescription as SheetDescription,
};
