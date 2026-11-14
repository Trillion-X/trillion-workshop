"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils";
import { PressWorkFace, usePressWork, type ButtonWork } from "../../button/press-work";

// A button that is not the page's one strong action keeps its own surface under the pointer and gets darker on top of
// it (the accent tint laid over it as an image), never a see-through colour that lets the page show through.
export const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] border font-medium text-base outline-none transition-[transform,box-shadow] active:scale-[0.98] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-control)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-loading:select-none data-[work=pending]:cursor-progress data-[work=pending]:disabled:opacity-100 data-[work=done]:border-[var(--color-success,#1a7f37)] data-[work=done]:bg-[var(--color-success,#1a7f37)] data-[work=done]:bg-none data-[work=done]:text-white data-[work=error]:border-destructive/48 data-[work=error]:text-destructive-foreground sm:text-sm [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-9 px-3 sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-sm": "size-8 sm:size-7",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-3 sm:h-9",
        sm: "h-8 gap-2 px-2 sm:h-7",
        xl: "h-11 px-4 text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 px-2 text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        // A button keeps its raised face (the sheen and the drop) in every state: at work, and disabled for any reason,
        // when it is only dimmed. A flat face reads as a broken button, so nothing here removes it.
        // The strong actions wear the look's button face (screen-look's resolver: --button-sheen over the fill, and
        // --button-highlight, --button-shadow for its edge, top line and drop), the same face as parts/ui Button.
        default:
          "border-transparent font-semibold bg-primary bg-[image:var(--button-sheen)] text-primary-foreground shadow-[var(--button-highlight),var(--button-shadow)] hover:bg-primary/90 data-pressed:bg-primary/90 *:data-[slot=button-loading-indicator]:text-primary-foreground [:active,[data-pressed]]:shadow-[var(--button-pressed-highlight)]",
        // Destructive never fills: it wears the outline's face with the danger colour, so the strong action alone is filled.
        destructive:
          "border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] hover:border-destructive/32 hover:bg-[image:linear-gradient(--theme(--color-destructive/6%),--theme(--color-destructive/6%))] data-pressed:border-destructive/32 data-pressed:bg-[image:linear-gradient(--theme(--color-destructive/6%),--theme(--color-destructive/6%))] *:data-[slot=button-loading-indicator]:text-foreground dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none",
        "destructive-outline":
          "border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] hover:border-destructive/32 hover:bg-[image:linear-gradient(--theme(--color-destructive/6%),--theme(--color-destructive/6%))] data-pressed:border-destructive/32 data-pressed:bg-[image:linear-gradient(--theme(--color-destructive/6%),--theme(--color-destructive/6%))] *:data-[slot=button-loading-indicator]:text-foreground dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none",
        ghost:
          "border-transparent text-foreground hover:bg-accent data-pressed:bg-accent *:data-[slot=button-loading-indicator]:text-foreground",
        link: "border-transparent text-foreground underline-offset-4 hover:underline data-pressed:underline *:data-[slot=button-loading-indicator]:text-foreground",
        outline:
          "border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] hover:border-foreground/20 hover:bg-[image:linear-gradient(var(--color-accent),var(--color-accent))] data-pressed:border-foreground/20 data-pressed:bg-[image:linear-gradient(var(--color-accent),var(--color-accent))] *:data-[slot=button-loading-indicator]:text-foreground dark:bg-input/32 dark:data-pressed:bg-input/64 dark:hover:bg-input/64 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-[image:linear-gradient(var(--color-accent),var(--color-accent))] data-pressed:bg-[image:linear-gradient(var(--color-accent),var(--color-accent))] *:data-[slot=button-loading-indicator]:text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80",
      },
    },
  },
);

/** What a button's work is doing, said in the button itself: the one owner is ../../button/press-work.tsx. A press
 *  whose handler returns a promise is the button's work; `work` is for work run elsewhere; `loading` is pending with
 *  the button's own words. */
export type { ButtonWork };

export interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  loading?: boolean;
  work?: ButtonWork | null;
  pendingLabel?: React.ReactNode;
  doneLabel?: React.ReactNode;
  errorLabel?: React.ReactNode;
}

export function Button({
  className,
  variant,
  size,
  render,
  children,
  loading = false,
  work: workProp,
  pendingLabel,
  doneLabel = "Done",
  errorLabel = "Try again",
  disabled: disabledProp,
  onClick,
  ...props
}: ButtonProps): React.ReactElement {
  const { work, onClick: press } = usePressWork(onClick, workProp, loading);
  const pending = work === "pending";
  const isDisabled: boolean = Boolean(pending || disabledProp);
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button";
  const iconOnly = typeof size === "string" && size.startsWith("icon");
  const defaultProps = {
    children: <PressWorkFace work={work} iconOnly={iconOnly} pendingLabel={pendingLabel} doneLabel={doneLabel} errorLabel={errorLabel}>{children}</PressWorkFace>,
    onClick: press,
    className: cn(buttonVariants({ className, size, variant })),
    "aria-busy": pending || undefined,
    "aria-disabled": pending || undefined,
    "data-loading": pending ? "" : undefined,
    "data-work": work,
    "data-slot": "button",
    disabled: isDisabled,
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
