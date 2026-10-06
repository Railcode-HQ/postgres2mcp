import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  // Sizing/appearance overrides for the inner <select> itself (height, text,
  // padding). `className` still targets the wrapper — see the note below.
  selectClassName?: string;
}

// A lightweight native <select> styled to match the Input component — same
// height, surface, and signal-blue focus ring — so it sits flush next to inputs
// without pulling in a popover dependency.
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, selectClassName, children, ...props }, ref) => (
    // `className` lands on the wrapper, not the <select>: the wrapper is the
    // layout box (e.g. the flex item / sized column), while the inner <select>
    // always fills it with w-full. Passing width/flex utilities to the <select>
    // instead would leave the wrapper stuck at w-full and starve a sibling
    // flex-1 input. Use `selectClassName` to resize the control itself.
    <div className={cn("relative w-full", className)}>
      <select
        ref={ref}
        className={cn(
          "h-8 w-full appearance-none rounded-md border border-input bg-card px-2.5 pr-8 text-[0.8125rem] text-foreground shadow-xs outline-none transition-colors",
          "focus:border-ring focus:ring-2 focus:ring-ring/25",
          "disabled:cursor-not-allowed disabled:opacity-50",
          selectClassName
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
);
Select.displayName = "Select";
