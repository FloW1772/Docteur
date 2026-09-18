import { useEffect, useRef } from 'react';

const dialogs: HTMLElement[] = [];
const focusable = 'button, a[href], input, select, textarea, summary, [tabindex]';

export function useStudioDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusable))
      .filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]') && el.getClientRects().length > 0);
    dialogs.push(dialog);
    const top = () => dialogs[dialogs.length - 1] === dialog;
    (controls()[0] ?? dialog).focus();
    function keydown(event: KeyboardEvent) {
      if (!top()) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close.current();
      }
      if (event.key !== 'Tab') return;
      const items = controls();
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (!items.length || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] ?? dialog : items[0] ?? dialog).focus();
      }
    }
    function focusin(event: FocusEvent) {
      if (top() && !dialog!.contains(event.target as Node)) (controls()[0] ?? dialog!).focus();
    }
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin);
      const wasTop = top();
      dialogs.splice(dialogs.indexOf(dialog), 1);
      if (wasTop && previous?.isConnected) previous.focus();
    };
  }, []);
  return ref;
}
