import { FormEvent, ReactNode, useCallback, useState } from "react";
import { Modal } from "./Modal";

type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // Styles the confirm button as destructive.
  danger?: boolean;
  // Ask for a value (e.g. a new password); the promise resolves with it.
  input?: { label: string; type?: "text" | "password"; minLength?: number };
};

type PendingConfirm = ConfirmOptions & { resolve: (value: string | null) => void };

/**
 * Promise-based replacement for window.confirm/window.prompt that renders the shared Modal.
 * `confirm()` resolves to the entered value ("" when there is no input) or null if cancelled.
 * Render `dialog` somewhere in the component.
 */
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [value, setValue] = useState("");

  const confirm = useCallback((options: ConfirmOptions) => new Promise<string | null>((resolve) => {
    setValue("");
    setPending({ ...options, resolve });
  }), []);

  const close = (result: string | null) => {
    pending?.resolve(result);
    setPending(null);
    setValue("");
  };

  const minLength = pending?.input?.minLength ?? 1;
  const canConfirm = !pending?.input || value.length >= minLength;

  const dialog = pending ? (
    <Modal title={pending.title} onClose={() => close(null)}>
      <form className="stack" onSubmit={(event: FormEvent) => { event.preventDefault(); if (canConfirm) close(value); }}>
        {pending.message && (typeof pending.message === "string" ? <p>{pending.message}</p> : pending.message)}
        {pending.input && (
          <label>
            {pending.input.label}
            <input
              type={pending.input.type ?? "text"}
              value={value}
              autoComplete={pending.input.type === "password" ? "new-password" : "off"}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={() => close(null)}>{pending.cancelLabel ?? "Cancel"}</button>
          <button type="submit" className={pending.danger ? "danger" : "primary"} disabled={!canConfirm}>
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </form>
    </Modal>
  ) : null;

  return { confirm, dialog };
}
