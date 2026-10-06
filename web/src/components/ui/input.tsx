import * as React from "react";

import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        // Inputs sit slightly inset from their surface (bg-background is a step
        // below bg-card), then lift to the surface colour on focus.
        "h-8 w-full rounded-md border border-input bg-card px-2.5 text-[0.8125rem] text-foreground shadow-xs outline-none transition-colors",
        "placeholder:text-muted-foreground/70",
        "focus:border-ring focus:ring-2 focus:ring-ring/25",
        // Invalid state (aria-invalid) overrides the border/ring with the destructive accent.
        "aria-invalid:border-destructive aria-invalid:focus:border-destructive aria-invalid:focus:ring-destructive/25",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
