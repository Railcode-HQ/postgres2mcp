import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/lib/useDialogFocus";
import { cn } from "@/lib/utils";

/**
 * A modal dialog — the surface for a focused task that needs its own form.
 * Throwaway prompts lean on `window.confirm`. Dismisses on Escape or a click on
 * the backdrop, unless `dismissible` is false: then only the dialog's own
 * buttons close it, for content that cannot be shown again.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
  bodyClassName,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  /** False keeps Escape, the backdrop and the corner button from closing it. */
  dismissible?: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Overrides the body's own scrolling — pass `overflow-hidden` when the
   *  dialog is a fixed height and its content manages scrolling itself, so the
   *  header and any in-body navigation stay put instead of scrolling away. */
  bodyClassName?: string;
}) {
  const panel = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  useDialogFocus(open, panel);

  React.useEffect(() => {
    if (!open || !dismissible) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismissible, onClose]);

  if (!open) return null;

  // Scroll lives on the overlay; the inner flex wrapper carries `min-h-full` so a
  // tall dialog stays reachable from the top instead of being clipped by vertical
  // centering. The dialog itself is capped to the viewport and scrolls its own
  // body, keeping the title + close affordance pinned while long forms (e.g. the
  // Bedrock credential set) scroll underneath.
  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto bg-scrim">
      <div
        className="flex min-h-full items-start justify-center p-4 sm:items-center"
        onMouseDown={(event) => {
          if (dismissible && event.target === event.currentTarget) onClose();
        }}
      >
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          className={cn(
            "relative flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col rounded-lg border border-border bg-card shadow-lg outline-none",
            className
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-4 pt-5">
            <div className="space-y-1">
              <h2 id={titleId} className="text-sm font-semibold text-foreground">{title}</h2>
              {description ? (
                <p id={descriptionId} className="text-[0.8125rem] text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>
            {dismissible ? (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="-mr-1.5 -mt-1.5 shrink-0"
              >
                <X />
              </Button>
            ) : null}
          </div>
          <div className={cn("min-h-0 overflow-y-auto px-5 pb-5", bodyClassName)}>
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
