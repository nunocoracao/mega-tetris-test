/**
 * The settings dialog: the cabinet's four preferences, the handling sliders,
 * and the key remapper.
 *
 * The dialog *behaviour* — focus trap, Escape, `inert` background — is
 * `ui/dialog.ts`'s, exactly as it is for the pause menu and the help panel;
 * this file owns only what is inside the panel. It holds no state of its own
 * beyond "which row is capturing a key": every control reads and writes through
 * an accessor, so there is one source of truth per setting and the footer's
 * quick toggles and this dialog can never disagree.
 *
 * Three things here are worth knowing before changing anything:
 *
 * **Capture is a keyboard mode, not a text field.** While a row is capturing,
 * a document-level listener takes the next keypress and turns it into a binding
 * — or into a sentence saying why it will not. `Tab`, `Enter` and `Escape` are
 * deliberately *not* swallowed: they are how a player gets out of a mode they
 * did not mean to enter, and a capture that ate them would be the trap the
 * remapper exists to prevent.
 *
 * **Every refusal is words.** A conflict, a reserved key, a modifier held, the
 * last pause key: each one puts a sentence in the panel *and* through the live
 * region. Nothing here is signalled by colour, because for some players there
 * is no colour.
 *
 * **The try-it strip is the sliders' output.** It borrows the same
 * `createAutoRepeat` the game and the on-screen pad use, driven by the same
 * live handling — so what it does under your finger is what the piece will do,
 * not an approximation of it.
 */

import type { ContrastSetting } from './contrast';
import { escapeHtml } from './help';
import {
  HANDLING_BOUNDS,
  RESERVED_KEYS,
  actionLabel,
  bindKey,
  captureKey,
  clampHandlingValue,
  clearKey,
  createAutoRepeat,
  defaultKeyMap,
  describeBinding,
  formatKeyLabel,
  isDefaultHandling,
  isDefaultKeyMap,
  normalizeKey,
  resetAction,
  DEFAULT_HANDLING,
  type ActionId,
  type Handling,
  type LiveBindings,
} from './input';
import type { MotionSetting } from './motion';
import type { SettingAccess } from './storage';
import type { ThemeId } from './theme';
import type { PadPreference } from './touch';

/** How many columns the try-it strip is wide. */
export const TRY_COLUMNS = 10;

/** Where the try-it block starts, and returns to when the dialog opens. */
export const TRY_START_COLUMN = 4;

/** A slider's value as the panel prints it. */
export function formatMs(value: number): string {
  return `${value} ms`;
}

/**
 * The elements the panel drives. Built once by `ui/shell.ts`, like every other
 * piece of furniture in the game — nothing here creates a dialog, it fills one.
 */
export interface SettingsElements {
  readonly dialog: HTMLElement;
  readonly panel: HTMLElement;
  readonly close: HTMLButtonElement;
  readonly done: HTMLButtonElement;
  /** The one line that explains a refusal, a capture, or a change. */
  readonly message: HTMLElement;
  readonly soundInput: HTMLInputElement;
  readonly motionInputs: readonly HTMLInputElement[];
  readonly contrastInputs: readonly HTMLInputElement[];
  /** The skin picker: one radio per theme, each with its own swatch. */
  readonly themeInputs: readonly HTMLInputElement[];
  readonly padInputs: readonly HTMLInputElement[];
  readonly handlingInputs: readonly HTMLInputElement[];
  readonly handlingValues: readonly HTMLElement[];
  readonly handlingReset: HTMLButtonElement;
  readonly tryField: HTMLElement;
  readonly tryBlock: HTMLElement;
  readonly tryButtons: readonly HTMLButtonElement[];
  readonly keymap: HTMLElement;
  readonly keysReset: HTMLButtonElement;
  readonly resetAsk: HTMLButtonElement;
  readonly resetConfirm: HTMLElement;
  readonly resetYes: HTMLButtonElement;
  readonly resetNo: HTMLButtonElement;
}

export interface SettingsPanelOptions {
  readonly elements: SettingsElements;
  /** The live bindings and handling — the panel's only writable game state. */
  readonly bindings: LiveBindings;
  readonly sound: SettingAccess<boolean>;
  readonly motion: SettingAccess<MotionSetting>;
  readonly contrast: SettingAccess<ContrastSetting>;
  readonly theme: SettingAccess<ThemeId>;
  readonly pad: SettingAccess<PadPreference>;
  /** Through the game's one live region. */
  readonly announce: (message: string) => void;
  /** Re-run the modal's focus trap after a row has been rebuilt. */
  readonly refresh?: () => void;
  /** Put every setting back to its default. Owned by the composition root. */
  readonly resetAll: () => void;
}

export interface SettingsPanel {
  /** Pull every control's value back out of the accessors. */
  render(): void;
  /** Drive the try-it strip. Call once per frame while the dialog is open. */
  update(deltaMs: number): void;
  /** Which row is waiting for a key, if any. */
  capturing(): ActionId | null;
  /** Leave capture mode without binding anything. Safe to call at any time. */
  cancelCapture(): void;
  /** Put the panel back in its resting state — called when the dialog opens. */
  reset(): void;
  destroy(): void;
}

/** The chips for one action's keys, with a way to take each one off. */
function keysMarkup(action: ActionId, keys: readonly string[]): string {
  if (keys.length === 0) {
    return '<span class="keyrow__empty">Not bound</span>';
  }
  return keys
    .map(
      (key) =>
        `<span class="keycap">
           <span class="keycap__label">${escapeHtml(formatKeyLabel(key))}</span>
           <button
             type="button"
             class="keycap__clear"
             data-key-clear="${escapeHtml(key)}"
             data-key-clear-action="${action}"
             aria-label="Clear ${escapeHtml(formatKeyLabel(key))} from ${escapeHtml(actionLabel(action))}"
           ><span aria-hidden="true">×</span></button>
         </span>`,
    )
    .join('');
}

export function createSettingsPanel(options: SettingsPanelOptions): SettingsPanel {
  const { elements, bindings } = options;
  const doc = elements.dialog.ownerDocument;

  /** The row waiting for a key, or `null` when nothing is. */
  let capturing: ActionId | null = null;
  /** Where the try-it block is, in columns. */
  let column = TRY_START_COLUMN;

  const tryRepeat = createAutoRepeat((action) => {
    if (action === 'moveLeft') {
      column = Math.max(0, column - 1);
    } else if (action === 'moveRight') {
      column = Math.min(TRY_COLUMNS - 1, column + 1);
    }
    paintTry();
  }, () => bindings.handling());

  function setMessage(text: string): void {
    elements.message.textContent = text;
  }

  /** Say it in the panel and out loud. Refusals are never colour alone. */
  function report(text: string): void {
    setMessage(text);
    options.announce(text);
  }

  // -- painting -------------------------------------------------------------

  function paintTry(): void {
    elements.tryField.style.setProperty('--try-column', String(column));
    elements.tryField.style.setProperty('--try-columns', String(TRY_COLUMNS));
  }

  function renderKeys(): void {
    const table = bindings.table();
    for (const binding of table.list) {
      const slot = elements.keymap.querySelector<HTMLElement>(
        `[data-key-keys="${binding.action}"]`,
      );
      if (slot !== null) {
        slot.innerHTML = keysMarkup(binding.action, binding.keys);
      }
      const bind = elements.keymap.querySelector<HTMLButtonElement>(
        `[data-key-bind="${binding.action}"]`,
      );
      if (bind !== null) {
        const active = capturing === binding.action;
        bind.textContent = active ? 'Press a key' : 'Add key';
        bind.setAttribute('aria-pressed', String(active));
        bind.setAttribute(
          'aria-label',
          active
            ? `Stop waiting for a key for ${binding.label}`
            : `Add a key for ${binding.label}`,
        );
      }
    }
    elements.keysReset.disabled = isDefaultKeyMap(table.map);
    options.refresh?.();
  }

  function renderHandling(): void {
    const handling = bindings.handling();
    for (const input of elements.handlingInputs) {
      const key = input.dataset['handling'] as keyof Handling | undefined;
      if (key === undefined) {
        continue;
      }
      input.value = String(handling[key]);
    }
    for (const node of elements.handlingValues) {
      const key = node.dataset['handlingValue'] as keyof Handling | undefined;
      if (key !== undefined) {
        node.textContent = formatMs(handling[key]);
      }
    }
    elements.handlingReset.disabled = isDefaultHandling(handling);
  }

  function renderChoices(): void {
    elements.soundInput.checked = options.sound.read();
    const chosen: readonly [readonly HTMLInputElement[], string][] = [
      [elements.motionInputs, options.motion.read()],
      [elements.contrastInputs, options.contrast.read()],
      [elements.themeInputs, options.theme.read()],
      [elements.padInputs, options.pad.read()],
    ];
    for (const [inputs, value] of chosen) {
      for (const input of inputs) {
        input.checked = input.value === value;
      }
    }
  }

  function render(): void {
    renderChoices();
    renderHandling();
    renderKeys();
    paintTry();
  }

  // -- capturing a key ------------------------------------------------------

  function endCapture(): void {
    if (capturing === null) {
      return;
    }
    capturing = null;
    doc.removeEventListener('keydown', onCaptureKey, true);
    renderKeys();
  }

  function cancelCapture(): void {
    if (capturing === null) {
      return;
    }
    endCapture();
    setMessage('Nothing was bound.');
  }

  function startCapture(action: ActionId): void {
    if (capturing === action) {
      cancelCapture();
      return;
    }
    endCapture();
    capturing = action;
    doc.addEventListener('keydown', onCaptureKey, true);
    // The strip must not run off while its keys are being reassigned.
    tryRepeat.releaseAll();
    renderKeys();
    report(`Press the key you want for ${actionLabel(action)}. Tab or Escape gets out.`);
  }

  function onCaptureKey(event: KeyboardEvent): void {
    const action = capturing;
    if (action === null) {
      return;
    }
    const key = normalizeKey(event.key);
    if (key === 'Tab') {
      // Checked *before* `defaultPrevented`, because the focus trap may already
      // have claimed this Tab to wrap the dialog — and the capture still has to
      // end. Never prevented here: Tab is how somebody gets out of a mode they
      // did not mean to enter, and out means focus really moving.
      endCapture();
      report('Tab moves between controls, so it cannot be a game key. Nothing was bound.');
      return;
    }
    if (event.defaultPrevented) {
      // Escape has already been claimed by the dialog, which is what closes it.
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const captured = captureKey(event);
    if (!captured.ok) {
      // A reserved key is a decision; a modifier is a fumble. The first ends
      // the capture, the second leaves it open so letting go is enough.
      if (RESERVED_KEYS.includes(key)) {
        endCapture();
      }
      report(captured.reason);
      return;
    }

    const bound = bindKey(bindings.table().map, action, captured.key);
    if (!bound.ok) {
      report(bound.reason);
      return;
    }
    bindings.setKeyMap(bound.map);
    endCapture();
    report(`${formatKeyLabel(captured.key)} is now ${actionLabel(action)}.`);
  }

  // -- listeners ------------------------------------------------------------

  /** Put focus somewhere sensible after a row rebuilds under it. */
  function focusRow(action: ActionId): void {
    elements.keymap
      .querySelector<HTMLButtonElement>(`[data-key-bind="${action}"]`)
      ?.focus();
  }

  function onKeymapClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const bind = target.closest<HTMLElement>('[data-key-bind]');
    if (bind !== null) {
      const action = bind.dataset['keyBind'] as ActionId | undefined;
      if (action !== undefined) {
        startCapture(action);
      }
      return;
    }

    const clear = target.closest<HTMLElement>('[data-key-clear]');
    if (clear !== null) {
      const action = clear.dataset['keyClearAction'] as ActionId | undefined;
      const key = clear.dataset['keyClear'];
      if (action === undefined || key === undefined) {
        return;
      }
      endCapture();
      const result = clearKey(bindings.table().map, action, key);
      if (!result.ok) {
        report(result.reason);
        return;
      }
      bindings.setKeyMap(result.map);
      report(`${formatKeyLabel(key)} is no longer ${actionLabel(action)}.`);
      focusRow(action);
      return;
    }

    const reset = target.closest<HTMLElement>('[data-key-reset]');
    if (reset !== null) {
      const action = reset.dataset['keyReset'] as ActionId | undefined;
      if (action === undefined) {
        return;
      }
      endCapture();
      bindings.setKeyMap(resetAction(bindings.table().map, action));
      const binding = bindings.table().list.find((candidate) => candidate.action === action);
      report(
        binding === undefined
          ? `${actionLabel(action)} is back to its default.`
          : `${binding.label} is back to ${describeBinding(binding)}.`,
      );
      focusRow(action);
    }
  }

  function onKeysReset(): void {
    endCapture();
    bindings.setKeyMap(defaultKeyMap());
    report('Every key is back to the default table.');
  }

  function onHandlingInput(event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const key = input.dataset['handling'] as keyof Handling | undefined;
    const bound = HANDLING_BOUNDS.find((candidate) => candidate.key === key);
    if (key === undefined || bound === undefined) {
      return;
    }
    const value = clampHandlingValue(Number(input.value), bound);
    bindings.setHandling({ ...bindings.handling(), [key]: value });
    renderHandling();
    setMessage(`${bound.label}: ${formatMs(value)}.`);
  }

  function onHandlingChange(event: Event): void {
    // `input` fires on every pixel of a drag and would flood the live region;
    // `change` fires once the player lets go, which is the moment worth saying.
    onHandlingInput(event);
    const message = elements.message.textContent ?? '';
    if (message !== '') {
      options.announce(message);
    }
  }

  function onHandlingReset(): void {
    bindings.setHandling(DEFAULT_HANDLING);
    renderHandling();
    report('Handling is back to the defaults.');
  }

  function onSoundChange(): void {
    options.sound.write(elements.soundInput.checked);
    render();
  }

  function choiceListener<T extends string>(access: SettingAccess<T>): (event: Event) => void {
    return (event: Event) => {
      const input = event.currentTarget;
      if (input instanceof HTMLInputElement && input.checked) {
        access.write(input.value as T);
        render();
      }
    };
  }

  const onMotionChange = choiceListener(options.motion);
  const onContrastChange = choiceListener(options.contrast);
  const onThemeChange = choiceListener(options.theme);
  const onPadChange = choiceListener(options.pad);

  // -- the try-it strip -----------------------------------------------------

  function onTryKeyDown(event: KeyboardEvent): void {
    if (capturing !== null || event.defaultPrevented) {
      return;
    }
    const binding = bindings.table().find(event.key);
    if (binding === undefined || (binding.action !== 'moveLeft' && binding.action !== 'moveRight')) {
      return;
    }
    event.preventDefault();
    if (!event.repeat) {
      tryRepeat.press(binding.action);
    }
  }

  function onTryKeyUp(event: KeyboardEvent): void {
    const binding = bindings.table().find(event.key);
    if (binding !== undefined) {
      tryRepeat.release(binding.action);
    }
  }

  function onTryBlur(): void {
    tryRepeat.releaseAll();
  }

  function tryActionOf(button: HTMLButtonElement): 'moveLeft' | 'moveRight' | null {
    const raw = button.dataset['tryButton'];
    return raw === 'moveLeft' || raw === 'moveRight' ? raw : null;
  }

  function onTryPointerDown(event: PointerEvent): void {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const action = tryActionOf(button);
    if (action !== null) {
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Capture is an improvement, never a requirement — see `ui/touch.ts`.
      }
      tryRepeat.press(action);
    }
  }

  function onTryPointerUp(event: Event): void {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const action = tryActionOf(button);
    if (action !== null) {
      tryRepeat.release(action);
    }
  }

  /** Enter and Space on a try button: one step, no hold to release. */
  function onTryClick(event: MouseEvent): void {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement) || event.detail !== 0) {
      return;
    }
    const action = tryActionOf(button);
    if (action !== null) {
      tryRepeat.press(action);
      tryRepeat.release(action);
    }
  }

  // -- resetting everything -------------------------------------------------

  function showResetConfirm(show: boolean): void {
    elements.resetConfirm.hidden = !show;
    elements.resetAsk.hidden = show;
    options.refresh?.();
    if (show) {
      elements.resetNo.focus();
    } else if (elements.resetAsk.isConnected) {
      elements.resetAsk.focus();
    }
  }

  function onResetAsk(): void {
    showResetConfirm(true);
  }

  function onResetNo(): void {
    showResetConfirm(false);
  }

  function onResetYes(): void {
    endCapture();
    options.resetAll();
    render();
    showResetConfirm(false);
    report('Every setting is back to the way it shipped.');
  }

  // -- wiring ---------------------------------------------------------------

  elements.keymap.addEventListener('click', onKeymapClick);
  elements.keysReset.addEventListener('click', onKeysReset);
  elements.handlingReset.addEventListener('click', onHandlingReset);
  elements.soundInput.addEventListener('change', onSoundChange);
  for (const input of elements.motionInputs) {
    input.addEventListener('change', onMotionChange);
  }
  for (const input of elements.contrastInputs) {
    input.addEventListener('change', onContrastChange);
  }
  for (const input of elements.themeInputs) {
    input.addEventListener('change', onThemeChange);
  }
  for (const input of elements.padInputs) {
    input.addEventListener('change', onPadChange);
  }
  for (const input of elements.handlingInputs) {
    input.addEventListener('input', onHandlingInput);
    input.addEventListener('change', onHandlingChange);
  }
  elements.tryField.addEventListener('keydown', onTryKeyDown);
  elements.tryField.addEventListener('keyup', onTryKeyUp);
  elements.tryField.addEventListener('blur', onTryBlur);
  for (const button of elements.tryButtons) {
    button.addEventListener('pointerdown', onTryPointerDown);
    button.addEventListener('pointerup', onTryPointerUp);
    button.addEventListener('pointercancel', onTryPointerUp);
    button.addEventListener('lostpointercapture', onTryPointerUp);
    button.addEventListener('click', onTryClick);
  }
  elements.resetAsk.addEventListener('click', onResetAsk);
  elements.resetNo.addEventListener('click', onResetNo);
  elements.resetYes.addEventListener('click', onResetYes);

  // The panel is a view of the bindings, so it repaints when they move —
  // including when something *else* moves them, like "reset all settings".
  const unlisten = bindings.listen(() => {
    renderKeys();
    renderHandling();
  });

  render();

  return {
    render,

    update(deltaMs: number): void {
      tryRepeat.update(deltaMs);
    },

    capturing: () => capturing,

    cancelCapture,

    reset(): void {
      endCapture();
      tryRepeat.releaseAll();
      column = TRY_START_COLUMN;
      elements.resetConfirm.hidden = true;
      elements.resetAsk.hidden = false;
      setMessage('');
      render();
    },

    destroy(): void {
      endCapture();
      unlisten();
      tryRepeat.releaseAll();
      elements.keymap.removeEventListener('click', onKeymapClick);
      elements.keysReset.removeEventListener('click', onKeysReset);
      elements.handlingReset.removeEventListener('click', onHandlingReset);
      elements.soundInput.removeEventListener('change', onSoundChange);
      for (const input of elements.motionInputs) {
        input.removeEventListener('change', onMotionChange);
      }
      for (const input of elements.contrastInputs) {
        input.removeEventListener('change', onContrastChange);
      }
      for (const input of elements.themeInputs) {
        input.removeEventListener('change', onThemeChange);
      }
      for (const input of elements.padInputs) {
        input.removeEventListener('change', onPadChange);
      }
      for (const input of elements.handlingInputs) {
        input.removeEventListener('input', onHandlingInput);
        input.removeEventListener('change', onHandlingChange);
      }
      elements.tryField.removeEventListener('keydown', onTryKeyDown);
      elements.tryField.removeEventListener('keyup', onTryKeyUp);
      elements.tryField.removeEventListener('blur', onTryBlur);
      for (const button of elements.tryButtons) {
        button.removeEventListener('pointerdown', onTryPointerDown);
        button.removeEventListener('pointerup', onTryPointerUp);
        button.removeEventListener('pointercancel', onTryPointerUp);
        button.removeEventListener('lostpointercapture', onTryPointerUp);
        button.removeEventListener('click', onTryClick);
      }
      elements.resetAsk.removeEventListener('click', onResetAsk);
      elements.resetNo.removeEventListener('click', onResetNo);
      elements.resetYes.removeEventListener('click', onResetYes);
    },
  };
}
