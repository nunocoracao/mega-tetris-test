/**
 * Modal dialogs, done properly.
 *
 * A dialog that is only a styled box is a keyboard trap in the other
 * direction: focus stays out in the page behind it, Escape does nothing, and a
 * screen reader keeps reading a game the player can no longer see. So a modal
 * here means all four of the things it is supposed to mean —
 *
 *  1. focus **moves in** when it opens,
 *  2. focus is **kept in** while it is open (Tab wraps at both ends),
 *  3. **Escape closes** it, from anywhere,
 *  4. focus **returns to the trigger** when it closes.
 *
 * Everything behind the dialog is marked `inert`, which is the platform's own
 * way of saying "not clickable, not focusable, not in the accessibility tree"
 * without the `aria-hidden`-over-focusable-content mistake. The Tab wrap below
 * is the belt to that braces: it keeps the trap correct on browsers where
 * `inert` is unsupported.
 *
 * The interesting decision — *where should Tab go?* — is `nextFocusIndex`, a
 * pure function, so the wrap can be tested without a browser.
 */

/** Elements that can hold focus, in DOM order, once the obviously-hidden go. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Where Tab should land, as an index into `focusables`.
 *
 * Returns `null` when the browser's own behaviour is already right — moving
 * between two elements that are both inside the dialog needs no help, and
 * intercepting it would only break anything unusual the user agent does.
 *
 * The wrap itself is the whole point: from the last element forwards, or the
 * first element backwards, focus would otherwise leave the dialog.
 */
export function nextFocusIndex(
  count: number,
  current: number,
  backwards: boolean,
): number | null {
  if (count === 0) {
    return null;
  }
  if (current < 0) {
    // Focus is somewhere we did not expect — pull it back to an end.
    return backwards ? count - 1 : 0;
  }
  if (backwards && current === 0) {
    return count - 1;
  }
  if (!backwards && current === count - 1) {
    return 0;
  }
  return null;
}

/** Is this element, or an ancestor of it, hidden outright? */
function isHidden(element: HTMLElement): boolean {
  return element.closest('[hidden]') !== null || element.closest('[inert]') !== null;
}

/** Focusable descendants of `root`, in DOM order. */
export function focusableWithin(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !isHidden(element),
  );
}

export interface Modal {
  readonly element: HTMLElement;
  /** Show it, move focus in, and remember where focus came from. */
  open(): void;
  /** Hide it and put focus back where it was. Safe to call when closed. */
  close(): void;
  isOpen(): boolean;
  /** Re-run the focus trap's idea of what is focusable. */
  refresh(): void;
  destroy(): void;
}

export interface ModalOptions {
  /** The outermost element of the dialog — the one carrying `hidden`. */
  readonly element: HTMLElement;
  /**
   * Everything that is *not* the dialog: made `inert` while it is open, so the
   * page behind cannot be clicked, tabbed to, or read.
   */
  readonly background: readonly HTMLElement[];
  /** Focus this on open instead of the first focusable thing. */
  readonly initialFocus?: () => HTMLElement | null;
  readonly onOpen?: () => void;
  /** Called after the dialog is hidden and focus has been restored. */
  readonly onClose?: () => void;
  /** Clicking the backdrop closes. On by default. */
  readonly closeOnBackdrop?: boolean;
}

export function createModal(options: ModalOptions): Modal {
  const { element, background } = options;
  const doc = element.ownerDocument;

  let open = false;
  /** Where focus was when we opened, so it can go back there. */
  let returnTo: HTMLElement | null = null;

  function focusables(): HTMLElement[] {
    return focusableWithin(element);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!open || event.defaultPrevented) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // Escape belongs to the dialog and stops here: without this the game's
      // own Escape binding would see it too and toggle the pause underneath.
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }

    const items = focusables();
    const active = doc.activeElement;
    const current = active instanceof HTMLElement ? items.indexOf(active) : -1;
    const target = nextFocusIndex(items.length, current, event.shiftKey);
    if (target === null) {
      return;
    }
    event.preventDefault();
    items[target]?.focus();
  }

  /**
   * A pointer that lands outside the dialog while it is open is a click on the
   * backdrop. `inert` already swallows clicks on the game behind, so this only
   * ever fires for the veil itself.
   */
  function onPointerDown(event: Event): void {
    if (!open || options.closeOnBackdrop === false) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && element.contains(target)) {
      const panel = element.querySelector('[role="dialog"]');
      if (panel === null || panel.contains(target)) {
        return;
      }
    }
    close();
  }

  function setBackgroundInert(inert: boolean): void {
    for (const node of background) {
      if (inert) {
        node.setAttribute('inert', '');
      } else {
        node.removeAttribute('inert');
      }
    }
  }

  function close(): void {
    if (!open) {
      return;
    }
    open = false;
    element.hidden = true;
    setBackgroundInert(false);
    doc.removeEventListener('keydown', onKeyDown, true);
    element.removeEventListener('pointerdown', onPointerDown);
    // Focus goes back to whatever opened us — but only if it is still there and
    // still focusable, otherwise we would be throwing focus into a void.
    if (returnTo !== null && returnTo.isConnected) {
      returnTo.focus();
    }
    returnTo = null;
    options.onClose?.();
  }

  return {
    element,

    open(): void {
      if (open) {
        return;
      }
      const active = doc.activeElement;
      returnTo = active instanceof HTMLElement ? active : null;
      open = true;
      element.hidden = false;
      setBackgroundInert(true);
      doc.addEventListener('keydown', onKeyDown, true);
      element.addEventListener('pointerdown', onPointerDown);
      options.onOpen?.();

      // A dialog always opens at its own beginning. Focusing a control near the
      // bottom of a long panel would scroll the player straight past the thing
      // they opened it to read, which is why the help panel focuses itself.
      for (const node of element.querySelectorAll('[role="dialog"]')) {
        node.scrollTop = 0;
      }

      const preferred = options.initialFocus?.() ?? null;
      const target = preferred ?? focusables()[0] ?? element;
      target.focus();
    },

    close,

    isOpen: () => open,

    refresh(): void {
      if (!open) {
        return;
      }
      const active = doc.activeElement;
      if (!(active instanceof HTMLElement) || !element.contains(active)) {
        focusables()[0]?.focus();
      }
    },

    destroy(): void {
      close();
      doc.removeEventListener('keydown', onKeyDown, true);
      element.removeEventListener('pointerdown', onPointerDown);
    },
  };
}
