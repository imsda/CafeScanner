import { ReactNode, useEffect, useId, useRef } from "react";

type ModalProps = {
  title: string;
  children: ReactNode;
  // Called on Escape or a click on the backdrop. Omit to make the dialog dismissible only via its own buttons.
  onClose?: () => void;
};

// Accessible dialog used for every confirmation in the app: labelled by its title,
// moves focus inside on open, keeps Tab within the dialog, restores focus on close.
export function Modal({ title, children, onClose }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    (focusable()[0] ?? dialog)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseRef.current?.(); }}
    >
      <div ref={dialogRef} className="confirm-modal stack" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h4 id={titleId}>{title}</h4>
        {children}
      </div>
    </div>
  );
}
