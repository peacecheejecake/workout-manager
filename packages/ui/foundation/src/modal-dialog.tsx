import { useEffect, useEffectEvent, useRef, type ReactNode, type RefObject } from 'react';
import { Button } from './button';
import styles from './modal-dialog.module.css';

export type ModalCloseReason = 'cancel' | 'close';
export type ModalUnavailableReason = 'native_dialog_unavailable' | 'modal_already_open';
export interface ModalDialogProps {
  open: boolean;
  title: string;
  titleId: string;
  closeLabel: string;
  initialFocusRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  onRequestClose(reason: ModalCloseReason): void;
  onOpenUnavailable(reason: ModalUnavailableReason): void;
  children: ReactNode;
  controls?: ReactNode;
}

function focusable(element: HTMLElement | null): element is HTMLElement {
  return Boolean(
    element?.isConnected && !element.matches(':disabled') && !element.closest('[hidden],[inert]'),
  );
}

/** One modal per document. A second modal is refused explicitly, never opened as non-modal.
 * Native showModal owns the top layer, background inertness and Tab navigation.
 */
export function ModalDialog({
  open,
  title,
  titleId,
  closeLabel,
  initialFocusRef,
  returnFocusRef,
  onRequestClose,
  onOpenUnavailable,
  children,
  controls,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const activeSession = useRef(false);
  const unavailable = useEffectEvent(onOpenUnavailable);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if (typeof dialog.showModal !== 'function' || typeof dialog.close !== 'function') {
      unavailable('native_dialog_unavailable');
      return;
    }
    const other = Array.from(dialog.ownerDocument.querySelectorAll('dialog[open]')).some(
      (element) => element !== dialog,
    );
    if (other) {
      unavailable('modal_already_open');
      return;
    }
    try {
      dialog.showModal();
    } catch {
      unavailable('native_dialog_unavailable');
      return;
    }
    activeSession.current = true;
    const trigger = returnFocusRef.current;
    const style = dialog.ownerDocument.body.style;
    const overflow = style.getPropertyValue('overflow');
    const priority = style.getPropertyPriority('overflow');
    style.setProperty('overflow', 'hidden');
    const initial = initialFocusRef.current;
    if (focusable(initial) && dialog.contains(initial)) initial.focus({ preventScroll: true });
    else closeRef.current?.focus({ preventScroll: true });
    return () => {
      activeSession.current = false;
      if (dialog.open) dialog.close();
      // Preserve a concurrent external style change instead of overwriting it.
      if (
        style.getPropertyValue('overflow') === 'hidden' &&
        !style.getPropertyPriority('overflow')
      ) {
        if (overflow) style.setProperty('overflow', overflow, priority);
        else style.removeProperty('overflow');
      }
      if (focusable(trigger)) trigger.focus({ preventScroll: true });
    };
  }, [open, initialFocusRef, returnFocusRef]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (activeSession.current) onRequestClose('cancel');
      }}
      onClose={(event) => {
        if (activeSession.current && open && !event.currentTarget.open) onRequestClose('close');
      }}
    >
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <Button ref={closeRef} variant="secondary" onClick={() => onRequestClose('close')}>
          {closeLabel}
        </Button>
      </header>
      <div className={styles.body}>{children}</div>
      {controls ? <footer className={styles.controls}>{controls}</footer> : null}
    </dialog>
  );
}
