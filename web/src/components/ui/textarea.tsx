import * as React from 'react'

import { cn } from '@/lib/utils'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

// The multi-line sibling of <Input>: same surface, border and focus ring.
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-md border border-input bg-card px-2.5 py-2 text-[0.8125rem] text-foreground shadow-xs outline-none transition-colors',
        'placeholder:text-muted-foreground/70',
        'focus:border-ring focus:ring-2 focus:ring-ring/25',
        'aria-invalid:border-destructive aria-invalid:focus:border-destructive aria-invalid:focus:ring-destructive/25',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
)
Textarea.displayName = 'Textarea'
