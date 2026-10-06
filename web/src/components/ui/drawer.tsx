import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/lib/useDialogFocus";
import { cn } from "@/lib/utils";

/**
 * A right-anchored slide-in panel — the surface for *reading* a record too tall
 * for a centered modal (an LLM call's messages, a query's SQL + result sample).
 * Mirrors <Modal>'s portal + Escape + backdrop dismissal, but stays mounted
 * through a short exit transition so the slide reads both ways. `eyebrow` is the
 * small mono kicker above the title (a request id / connector name); `footer`
 * pins a bar below the scroll area, for a drawer that edits rather than reads
 * (its Save must stay reachable however far down the form you are).
 */
export function Drawer({
  open,
  onClose,
  eyebrow,
  title,
  meta,
  footer,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const [mounted, setMounted] = React.useState(open);
  const [visible, setVisible] = React.useState(false);
  const panel = React.useRef<HTMLElement>(null);
  const titleId = React.useId();
  // Held while the panel is on screen, not through its exit slide.
  useDialogFocus(open && mounted, panel);

  // Drive the enter/exit transition: mount → next frame flips `visible` on (slide
  // in); on close, flip `visible` off, then unmount once the 200ms slide finishes.
  React.useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
    const timer = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(timer);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className={cn(
          "absolute inset-0 bg-scrim transition-opacity duration-200",
          visible ? "opacity-100" : "opacity-0"
        )}
        onMouseDown={onClose}
      />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-border bg-card shadow-lg outline-none transition-transform duration-200 ease-out",
          visible ? "translate-x-0" : "translate-x-full",
          className
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0 space-y-1">
            {eyebrow ? (
              <div className="font-mono text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                {eyebrow}
              </div>
            ) : null}
            <h2 id={titleId} className="truncate text-sm font-semibold text-foreground">{title}</h2>
            {meta ? <div className="flex flex-wrap items-center gap-2 pt-0.5">{meta}</div> : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1.5 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="shrink-0 border-t border-border px-5 py-3">{footer}</footer>
        ) : null}
      </aside>
    </div>,
    document.body
  );
}
