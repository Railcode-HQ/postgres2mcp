import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Dense record tables — the surface for scanning many rows at once (the
 * instance console's organizations and users).
 *
 * Rows are 34px with a hairline between them, numbers are tabular, and the
 * header is a single sticky hairline rather than a filled band: at this density
 * a heavier header competes with the data it labels. `<Table>` owns the
 * horizontal scroll so a wide table never widens the page.
 */
export function Table({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn("w-full border-collapse text-[0.8125rem]", className)}
        {...props}
      >
        {children}
      </table>
    </div>
  );
}

export function THead({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        "sticky top-0 z-10 bg-background text-left [&_th]:border-b [&_th]:border-border",
        className
      )}
      {...props}
    >
      {children}
    </thead>
  );
}

export function TH({
  className,
  numeric = false,
  children,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "h-8 px-3 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground",
        numeric && "text-right",
        className
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function TBody({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cn("divide-y divide-border", className)} {...props}>
      {children}
    </tbody>
  );
}

// `interactive` marks a row that behaves like a control (opens a drawer): it
// lights on hover and keeps a visible focus ring for keyboard users.
export function TR({
  className,
  interactive = false,
  children,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }) {
  return (
    <tr
      className={cn(
        "transition-colors",
        interactive &&
          "cursor-pointer outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      {children}
    </tr>
  );
}

export function TD({
  className,
  numeric = false,
  children,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        "h-[2.125rem] px-3 align-middle",
        numeric && "text-right tabular-nums",
        className
      )}
      {...props}
    >
      {children}
    </td>
  );
}
