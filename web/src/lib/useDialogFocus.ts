import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/**
 * What a dialog owes the keyboard: focus moves into it when it opens, Tab stays
 * inside it while it is open, and focus goes back to where it was when it
 * closes. The panel needs `tabIndex={-1}` so it can hold focus itself when
 * nothing inside asked for it.
 */
export function useDialogFocus(open: boolean, panel: RefObject<HTMLElement | null>): void {
  // Noted while rendering, before an autoFocus inside the dialog can move it.
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current) opener.current = document.activeElement as HTMLElement | null
  wasOpen.current = open

  useEffect(() => {
    if (!open) return
    const node = panel.current
    if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true })

    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !node) return
      const stops = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      const first = stops[0]
      const last = stops[stops.length - 1]
      if (!first || !last) {
        event.preventDefault()
        return
      }
      const active = document.activeElement
      if (!node.contains(active)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Back to the control that opened it, if that is still on the page.
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
    }
  }, [open, panel])
}
