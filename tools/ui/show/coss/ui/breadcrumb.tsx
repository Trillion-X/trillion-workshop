"use client";

import { ChevronRight } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";

export function Breadcrumb({
  ...props
}: React.ComponentProps<"nav">): React.ReactElement {
  return <nav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />;
}

export function BreadcrumbList({
  className,
  ...props
}: React.ComponentProps<"ol">): React.ReactElement {
  return (
    <ol
      className={cn(
        "flex flex-wrap items-center gap-1.5 break-words text-sm text-muted-foreground sm:gap-2.5",
        className,
      )}
      data-slot="breadcrumb-list"
      {...props}
    />
  );
}

export function BreadcrumbItem({
  className,
  ...props
}: React.ComponentProps<"li">): React.ReactElement {
  return (
    <li
      className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", className)}
      data-slot="breadcrumb-item"
      {...props}
    />
  );
}

export function BreadcrumbLink({
  className,
  ...props
}: React.ComponentProps<"button">): React.ReactElement {
  return (
    <button
      type="button"
      className={cn("min-w-0 max-w-full cursor-pointer text-left [overflow-wrap:anywhere] transition-colors hover:text-foreground", className)}
      data-slot="breadcrumb-link"
      {...props}
    />
  );
}

export function BreadcrumbPage({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactElement {
  return (
    <span
      aria-current="page"
      className={cn("min-w-0 max-w-full font-normal text-foreground [overflow-wrap:anywhere]", className)}
      data-slot="breadcrumb-page"
      {...props}
    />
  );
}

export function BreadcrumbSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"li">): React.ReactElement {
  return (
    <li
      aria-hidden="true"
      className={cn("opacity-80 [&>svg]:size-4", className)}
      data-slot="breadcrumb-separator"
      role="presentation"
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  );
}
