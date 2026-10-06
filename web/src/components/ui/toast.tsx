import * as React from "react";
import { createPortal } from "react-dom";
import { AlertCircle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToastStore, type Toast } from "@/stores/toastStore";
import { cn } from "@/lib/utils";

/**
 * The toast viewport. Mounted ONCE (see App.tsx) and portaled to <body>, like
 * `ui/modal.tsx`, so it survives route changes and never inherits a transformed
 * or overflow-hidden ancestor.
 *
 * Accessibility: the stack is a polite live region so a screen reader announces
 * a new toast without interrupting, and every toast's action is a real <button>
 * inside the DOM — an Undo you can't reach with the keyboard isn't an Undo.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  // The region stays mounted even when empty: a live region has to exist BEFORE
  // content lands in it, or the very first toast goes unannounced. It is
  // pointer-events-none and renders nothing, so an empty viewport costs nothing.
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body
  );
}

function ToastRow({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const [paused, setPaused] = React.useState(false);

  // The countdown restarts when the pause lifts, on purpose: someone who hovered
  // to read the message gets the full window back to decide, rather than losing
  // whatever was left of it.
  React.useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [paused, toast.id, toast.durationMs, dismiss]);

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      role={toast.tone === "error" ? "alert" : undefined}
      className={cn(
        "pointer-events-auto flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3 text-[0.8125rem] shadow-lg",
        toast.tone === "error" ? "border-destructive/40" : "border-border"
      )}
    >
      {toast.tone === "error" ? (
        <AlertCircle aria-hidden="true" className="size-4 shrink-0 text-destructive" />
      ) : null}
      <span className="min-w-0 flex-1 text-foreground">{toast.message}</span>
      {toast.action ? (
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => {
            toast.action?.onClick();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        type="button"
        aria-label="Dismiss"
        className="-mr-1.5 size-7 shrink-0"
        onClick={() => dismiss(toast.id)}
      >
        <X />
      </Button>
    </div>
  );
}
