import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { Button, type ButtonProps } from '@/components/ui/button'

// Copies `value` and confirms in place for a moment — the check replaces the
// icon, so there is no toast to dismiss for something this small.
export function CopyButton({
  value,
  label,
  ...props
}: { value: string; label?: string } & Omit<ButtonProps, 'onClick' | 'children' | 'value'>) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  return (
    <Button
      type="button"
      variant="outline"
      size={label ? 'sm' : 'icon'}
      aria-label={label ? undefined : 'Copy'}
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true))
      }}
      {...props}
    >
      {copied ? <Check /> : <Copy />}
      {label ? (copied ? 'Copied' : label) : null}
    </Button>
  )
}
