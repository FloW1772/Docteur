// [Global Loading V1] GLOBAL BLOCKING OPERATION — full-screen overlay, reserved
// for operations during which the rest of the app must not be used (restoring
// a backup over the neurons on screen). Real background work must never use it.
//
// Accessibility: role="alertdialog" + aria-modal, focus moved into the
// overlay while it is open and restored afterwards, Tab kept inside, Escape
// cancels only when the operation is really cancellable.
import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  children: ReactNode;
  onEscape?: () => void;
}

export default function BlockingOverlay({ open, title, children, onEscape }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const box = boxRef.current;
    const focusables = () => [...(box?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? [])];
    (focusables()[0] ?? box)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) { event.preventDefault(); box?.focus(); return; }
      const first = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); lastItem.focus(); }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="dl-overlay">
      <div ref={boxRef} className="dl-overlay-box" role="alertdialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <h2 className="dl-overlay-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
