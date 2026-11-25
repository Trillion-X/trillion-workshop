"use client";

// The coss kit's button is the one shared Button (../../button/Button.tsx): its faces, sizes, work states and look all
// come from there, and the coss words for them (default, destructive, outline, link; default, xl, icon-sm, ...) are rows of
// that Button's NAMES_FROM_OTHER_KITS. What stays here is only what a coss part expects of its button when it says
// nothing: the strong face, a press that never submits a form, and the coss slot name its sheets select on.
import * as React from "react";
import { Button as OneButton, buttonVariants, type ButtonProps as OneButtonProps } from "../../button/Button";
import type { ButtonWork } from "../../button/press-work";

export { buttonVariants };
export type { ButtonWork };
export type ButtonProps = OneButtonProps;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", type, render, href, ...props },
  ref,
) {
  return <OneButton ref={ref} data-slot="button" variant={variant} type={type ?? (render || href != null ? undefined : "button")} render={render} href={href} {...props} />;
});
