/**
 * Keyboard input.
 *
 * Two things make keyboard controls feel good, and both live here:
 *
 *  - **Our own repeat timing.** The operating system's key repeat is slow to
 *    start and inconsistent between machines, so `keydown` events flagged
 *    `repeat` are dropped and movement is re-emitted from the game loop with
 *    DAS/ARR timing instead: one move on press, a pause, then a fast stream.
 *  - **Restraint about what it swallows.** Bound keys have their default
 *    prevented so arrows and space never scroll the page, but a shortcut with
 *    Cmd/Ctrl/Alt held, or a key pressed while a button or field has focus,
 *    is left entirely alone.
 *
 * The binding table is exported as data. The help panel, and any future
 * remapping UI, must read `KEY_BINDINGS` rather than restate the list.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Delayed Auto Shift: how long a direction is held before it starts repeating. */
export const DAS_DELAY_MS = 170;

/** Auto Repeat Rate: the gap between repeats once DAS has charged. */
export const ARR_INTERVAL_MS = 40;

/** Soft drop repeats straight away, at a steady rate. */
export const SOFT_DROP_INTERVAL_MS = 35;

/**
 * Ceiling on repeats emitted from one frame. A frame is normally one repeat;
 * this only bites after a very long frame, where flooding the engine with
 * queued moves would be worse than dropping them.
 */
const MAX_REPEATS_PER_FRAME = 8;

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/**
 * What a key does. Everything except `togglePause` and `restart` is an engine
 * input; those two are intents the composition layer resolves against the
 * current status, because "which of pause and resume applies" is not the
 * keyboard's business.
 */
export type ActionId =
  | 'moveLeft'
  | 'moveRight'
  | 'softDrop'
  | 'hardDrop'
  | 'rotateCW'
  | 'rotateCCW'
  | 'hold'
  | 'togglePause'
  | 'restart';

/** How an action behaves while its key stays down. */
export type RepeatMode =
  /** Fires once per press. */
  | 'none'
  /** Fires, waits `DAS_DELAY_MS`, then repeats every `ARR_INTERVAL_MS`. */
  | 'das'
  /** Fires, then repeats every `SOFT_DROP_INTERVAL_MS`. */
  | 'soft';

export interface KeyBinding {
  readonly action: ActionId;
  /** Human-readable name of the action, for the help panel. */
  readonly label: string;
  /**
   * Keys that trigger it, as normalised `KeyboardEvent.key` values: printable
   * keys upper-cased (so `'A'`, `' '`), named keys verbatim (`'ArrowLeft'`).
   */
  readonly keys: readonly string[];
  readonly repeat: RepeatMode;
}

/** The default bindings, in the order a help panel should list them. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { action: 'moveLeft', label: 'Move left', keys: ['ArrowLeft', 'A'], repeat: 'das' },
  { action: 'moveRight', label: 'Move right', keys: ['ArrowRight', 'D'], repeat: 'das' },
  { action: 'softDrop', label: 'Soft drop', keys: ['ArrowDown', 'S'], repeat: 'soft' },
  { action: 'hardDrop', label: 'Hard drop', keys: [' '], repeat: 'none' },
  { action: 'rotateCW', label: 'Rotate right', keys: ['ArrowUp', 'X'], repeat: 'none' },
  { action: 'rotateCCW', label: 'Rotate left', keys: ['Z', 'Control'], repeat: 'none' },
  { action: 'hold', label: 'Hold piece', keys: ['C', 'Shift'], repeat: 'none' },
  { action: 'togglePause', label: 'Pause / resume', keys: ['P', 'Escape'], repeat: 'none' },
  { action: 'restart', label: 'Restart', keys: ['R'], repeat: 'none' },
];

/** Lookup table built once from `KEY_BINDINGS`. Keys are unique — a test says so. */
const BY_KEY: ReadonlyMap<string, KeyBinding> = new Map(
  KEY_BINDINGS.flatMap((binding) => binding.keys.map((key) => [key, binding] as const)),
);

/**
 * `KeyboardEvent.key`, normalised for lookup: printable keys are upper-cased
 * so `a` and `A` are the same binding, named keys pass through untouched.
 */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The binding for a raw `KeyboardEvent.key`, if there is one. */
export function findBinding(key: string): KeyBinding | undefined {
  return BY_KEY.get(normalizeKey(key));
}

/** A key's name as a player would read it: `'ArrowLeft'` → `'←'`. */
export function formatKeyLabel(key: string): string {
  switch (key) {
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case ' ':
      return 'Space';
    case 'Escape':
      return 'Esc';
    case 'Control':
      return 'Ctrl';
    default:
      return key;
  }
}

/** A binding's keys as one readable string, e.g. `'← / A'`. */
export function describeBinding(binding: KeyBinding): string {
  return binding.keys.map(formatKeyLabel).join(' / ');
}

// ---------------------------------------------------------------------------
// Auto-repeat timing (pure)
// ---------------------------------------------------------------------------

/** Where a held key is in its repeat cycle. */
export interface RepeatState {
  /** Milliseconds accumulated toward the next emission. */
  readonly elapsedMs: number;
  /** The initial delay is spent, so repeats now come every `intervalMs`. */
  readonly charged: boolean;
}

/** A key that was just pressed: the press itself has fired, nothing is due. */
export const FRESH_REPEAT: RepeatState = { elapsedMs: 0, charged: false };

/**
 * Advance a held key's repeat clock by `deltaMs` and report how many repeats
 * came due.
 *
 * Pure, and therefore the part worth testing: everything about how movement
 * *feels* is in these few lines. Leftover time carries into the next call, so
 * repeat timing does not drift with the frame rate, and a backlog larger than
 * `MAX_REPEATS_PER_FRAME` is dropped rather than queued.
 */
export function stepRepeat(
  state: RepeatState,
  deltaMs: number,
  delayMs: number,
  intervalMs: number,
): { readonly state: RepeatState; readonly repeats: number } {
  if (!(deltaMs > 0) || !(intervalMs > 0)) {
    return { state, repeats: 0 };
  }

  let elapsed = state.elapsedMs + deltaMs;
  let charged = state.charged;
  let repeats = 0;

  if (!charged) {
    if (elapsed < delayMs) {
      return { state: { elapsedMs: elapsed, charged: false }, repeats: 0 };
    }
    charged = true;
    elapsed -= delayMs;
    repeats = 1;
  }

  while (elapsed >= intervalMs && repeats < MAX_REPEATS_PER_FRAME) {
    elapsed -= intervalMs;
    repeats += 1;
  }
  if (elapsed >= intervalMs) {
    elapsed = 0; // Dropped the backlog; do not let it accumulate.
  }

  return { state: { elapsedMs: elapsed, charged }, repeats };
}

// ---------------------------------------------------------------------------
// The keyboard controller
// ---------------------------------------------------------------------------

export interface KeyboardInputOptions {
  /** Called once per press and once per auto-repeat. */
  readonly onAction: (action: ActionId) => void;
  /** Where to listen. Defaults to `window`. */
  readonly target?: EventTarget;
}

export interface KeyboardInput {
  /** Drive auto-repeat. Call once per frame with the real elapsed time. */
  update(deltaMs: number): void;
  /** Forget every held key — used when the window loses focus. */
  releaseAll(): void;
  destroy(): void;
}

/** Keys pressed while one of these has focus belong to the control, not the game. */
const INTERACTIVE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A']);

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) {
    return false;
  }
  return INTERACTIVE_TAGS.has(target.tagName) || target.isContentEditable;
}

/**
 * Start listening. Returns a handle whose `update` must be called from the
 * game loop — without it, keys fire once and never repeat.
 */
export function createKeyboardInput(options: KeyboardInputOptions): KeyboardInput {
  const target = options.target ?? window;
  const emit = options.onAction;

  /** Actions whose key is currently down. */
  const held = new Set<ActionId>();
  /** The direction that owns auto-repeat: the most recently pressed one. */
  let activeDirection: 'moveLeft' | 'moveRight' | null = null;
  let horizontalRepeat: RepeatState = FRESH_REPEAT;
  let softRepeat: RepeatState = FRESH_REPEAT;

  function press(binding: KeyBinding): void {
    if (held.has(binding.action)) {
      return;
    }
    held.add(binding.action);

    if (binding.action === 'moveLeft' || binding.action === 'moveRight') {
      activeDirection = binding.action;
      horizontalRepeat = FRESH_REPEAT;
    } else if (binding.action === 'softDrop') {
      softRepeat = FRESH_REPEAT;
    }

    emit(binding.action);
  }

  function release(action: ActionId): void {
    held.delete(action);

    if (action === activeDirection) {
      // Fall back to the opposite direction if it is still down, and give it a
      // fresh DAS charge so it does not warp across the board.
      const other = action === 'moveLeft' ? 'moveRight' : 'moveLeft';
      activeDirection = held.has(other) ? other : null;
      horizontalRepeat = FRESH_REPEAT;
    }
  }

  function onKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || event.defaultPrevented) {
      return;
    }
    // A shortcut is being typed (Cmd+R, Alt+Tab, Ctrl+F): stay out of the way.
    // `Control` itself is a binding, so it is the one ctrl-ish key we accept.
    if (event.metaKey || event.altKey) {
      return;
    }
    if (event.ctrlKey && normalizeKey(event.key) !== 'Control') {
      return;
    }
    if (isInteractiveTarget(event.target)) {
      return;
    }

    const binding = findBinding(event.key);
    if (binding === undefined) {
      return;
    }

    // Prevented even for OS repeats, so holding an arrow never scrolls.
    event.preventDefault();
    if (event.repeat) {
      return;
    }
    press(binding);
  }

  function onKeyUp(event: Event): void {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    // Released unconditionally — including with a modifier down, which is how a
    // key that went down before Cmd was pressed avoids getting stuck on.
    const binding = findBinding(event.key);
    if (binding !== undefined) {
      release(binding.action);
    }
  }

  function releaseAll(): void {
    held.clear();
    activeDirection = null;
    horizontalRepeat = FRESH_REPEAT;
    softRepeat = FRESH_REPEAT;
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', releaseAll);

  return {
    update(deltaMs: number): void {
      if (activeDirection !== null) {
        const stepped = stepRepeat(horizontalRepeat, deltaMs, DAS_DELAY_MS, ARR_INTERVAL_MS);
        horizontalRepeat = stepped.state;
        for (let i = 0; i < stepped.repeats; i += 1) {
          emit(activeDirection);
        }
      }
      if (held.has('softDrop')) {
        const stepped = stepRepeat(
          softRepeat,
          deltaMs,
          SOFT_DROP_INTERVAL_MS,
          SOFT_DROP_INTERVAL_MS,
        );
        softRepeat = stepped.state;
        for (let i = 0; i < stepped.repeats; i += 1) {
          emit('softDrop');
        }
      }
    },
    releaseAll,
    destroy(): void {
      releaseAll();
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', releaseAll);
    },
  };
}
