"use client";

// Adapted from assistant-ui's base Dialog (MIT). Upstream renders a Base UI
// modal dialog with a dimming backdrop. Here the same parts open the shared
// floating panel instead: a movable, resizable window beside the page, with no
// backdrop, no aria-modal and no focus trap. Nothing in the shared packages
// opens as a blocking modal.

import * as React from "react";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FloatingView } from "../../../../../../floating-panel-opener/FloatingView";

type DialogState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  label: string;
  setLabel: (label: string) => void;
};

const DialogContext = React.createContext<DialogState | null>(null);

function useDialog(): DialogState {
  const state = React.useContext(DialogContext);
  if (!state) throw new Error("Dialog parts must be placed inside <Dialog>.");
  return state;
}

function Dialog({
  open,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}) {
  const [inner, setInner] = React.useState(defaultOpen);
  const [label, setLabel] = React.useState("Details");
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (open === undefined) setInner(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );
  const value = React.useMemo(
    () => ({ open: open ?? inner, setOpen, label, setLabel }),
    [open, inner, setOpen, label],
  );
  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

type PartProps = React.ComponentProps<"button"> & {
  /** Base UI style: the element to act as the trigger. */
  render?: React.ReactElement;
  nativeButton?: boolean;
  /** Radix style: the only child acts as the trigger. */
  asChild?: boolean;
};

function actOn(
  { render: renderProp, nativeButton: _nativeButton, asChild, className, children, onClick, ...props }: PartProps,
  slot: string,
  act: () => void,
) {
  const render = renderProp ?? (asChild && React.isValidElement(children) ? children : undefined);
  if (asChild && render === children) children = undefined;
  if (render && React.isValidElement(render)) {
    const element = render as React.ReactElement<{ className?: string; onClick?: React.MouseEventHandler; children?: React.ReactNode }>;
    return React.cloneElement(element, {
      ...props,
      "data-slot": slot,
      className: cn(element.props.className, className),
      onClick: (event: React.MouseEvent) => {
        element.props.onClick?.(event);
        onClick?.(event as React.MouseEvent<HTMLButtonElement>);
        act();
      },
      children: children ?? element.props.children,
    } as Record<string, unknown>);
  }
  return (
    <button
      type="button"
      data-slot={slot}
      className={className}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        act();
      }}
    >
      {children}
    </button>
  );
}

function DialogTrigger(props: PartProps) {
  const { setOpen } = useDialog();
  return actOn(props, "dialog-trigger", () => setOpen(true));
}

function DialogClose(props: PartProps) {
  const { setOpen } = useDialog();
  return actOn(props, "dialog-close", () => setOpen(false));
}

function DialogContent({
  className,
  children,
  width = 520,
  showCloseButton: _showCloseButton,
  ...props
}: React.ComponentProps<"div"> & {
  /** The floating panel always has its own close button. */
  showCloseButton?: boolean;
  /** Starting width of the panel in pixels. */
  width?: number;
}) {
  const { open, setOpen, label } = useDialog();
  return (
    <FloatingView open={open} onClose={() => setOpen(false)} label={label} width={width}>
      <div
        data-slot="dialog-content"
        className={cn("grid gap-4 text-sm", className)}
        {...props}
      >
        {children}
      </div>
    </FloatingView>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogClose render={<Button variant="outline" />}>
          <XIcon />
          Close
        </DialogClose>
      )}
    </div>
  );
}

// The title names the panel, so a screen reader announces what opened.
function DialogTitle({ className, children, ...props }: React.ComponentProps<"h2">) {
  const { setLabel } = useDialog();
  const text = typeof children === "string" ? children.trim() : "";
  React.useLayoutEffect(() => {
    if (text) setLabel(text);
  }, [text, setLabel]);
  return (
    <h2
      data-slot="dialog-title"
      className={cn(
        "cn-font-heading text-base leading-none font-medium",
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="dialog-description"
      className={cn(
        "text-muted-foreground *:[a]:hover:text-foreground text-sm *:[a]:underline *:[a]:underline-offset-3",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
