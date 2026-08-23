/**
 * Keyboard input: the binding table, the rules for editing it, and the
 * auto-repeat clock every held control shares.
 *
 * Three things make keyboard controls feel good, and all three live here:
 *
 *  - **Our own repeat timing.** The operating system's key repeat is slow to
 *    start and inconsistent between machines, so `keydown` events flagged
 *    `repeat` are dropped and movement is re-emitted from the game loop with
 *    DAS/ARR timing instead: one move on press, a pause, then a fast stream.
 *  - **Restraint about what it swallows.** Bound keys have their default
 *    prevented so arrows and space never scroll the page, but a shortcut with
 *    Cmd/Ctrl/Alt held, or a key pressed while a button or field has focus,
 *    is left entirely alone.
 *  - **Bindings and handling are data, not constants.** `KEY_BINDINGS` is the
 *    *default* table and `DEFAULT_HANDLING` the *default* timing; what the
 *    keyboard actually obeys is whatever `createKeyboardInput` is handed, which
 *    is what lets `ui/settings.ts` change either one mid-run with no reload.
 *
 * The repeat clock is exported separately as `createAutoRepeat`, because a
 * held on-screen button has to feel exactly like a held key — `ui/touch.ts`
 * drives the same object rather than keeping a second copy of the timing.
 *
 * **This file is the only place the key list exists.** The help panel, the
 * controls card, the on-screen pad and the remapping UI all read a
 * `BindingTable`; none of them restates a key, and `help.test.ts` and
 * `wiring.test.ts` say so.
 */

import type { SettingAccess } from './storage';

// ---------------------------------------------------------------------------
// Handling
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
 * queued moves would be worse than dropping them — and at an ARR of zero,
 * where it *is* the rate. See `stepRepeat`.
 */
export const MAX_REPEATS_PER_FRAME = 8;

/** The three numbers that decide how held controls feel, in milliseconds. */
export interface Handling {
  /** Hold before left/right start repeating. */
  readonly dasMs: number;
  /** Gap between sideways repeats. Zero means "as fast as the frame allows". */
  readonly arrMs: number;
  /** Gap between soft-dropped rows. */
  readonly softDropMs: number;
}

export const DEFAULT_HANDLING: Handling = {
  dasMs: DAS_DELAY_MS,
  arrMs: ARR_INTERVAL_MS,
  softDropMs: SOFT_DROP_INTERVAL_MS,
};

/** One slider: its range, its step, and the words beside it. */
export interface HandlingBound {
  readonly key: keyof Handling;
  readonly label: string;
  readonly hint: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/**
 * The bounds, and the two decisions inside them worth stating out loud.
 *
 * **ARR may be zero.** "Instant" sideways movement is a setting a real
 * population of players wants, and it is safe to give them: a piece that slides
 * to the wall in one frame can be slid straight back. Zero is implemented as
 * `MAX_REPEATS_PER_FRAME` steps per frame rather than a literal teleport —
 * eight columns a frame crosses a ten-wide well in two frames, and the cap is
 * what stops one long frame flooding the engine (and the replay tape) with
 * hundreds of queued moves.
 *
 * **Soft drop may not.** The same trick downwards is not reversible: a piece
 * cannot come back up, so a zero here would be a hard drop with extra steps and
 * would cost a player pieces they meant to place. Five milliseconds is already
 * a row every frame, which is as fast as anybody can see.
 */
export const HANDLING_BOUNDS: readonly HandlingBound[] = [
  {
    key: 'dasMs',
    label: 'Delay before repeat (DAS)',
    hint: 'How long you hold left or right before the piece starts sliding.',
    min: 0,
    max: 500,
    step: 5,
  },
  {
    key: 'arrMs',
    label: 'Repeat rate (ARR)',
    hint: 'The gap between sideways steps once it is sliding. Zero is as fast as the frame allows.',
    min: 0,
    max: 100,
    step: 5,
  },
  {
    key: 'softDropMs',
    label: 'Soft drop rate',
    hint: 'The gap between rows while soft drop is held.',
    min: 5,
    max: 200,
    step: 5,
  },
];

/** A number forced into a bound's range and onto its step. */
export function clampHandlingValue(raw: unknown, bound: HandlingBound): number {
  const fallback = DEFAULT_HANDLING[bound.key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  const snapped = Math.round(raw / bound.step) * bound.step;
  return Math.min(bound.max, Math.max(bound.min, snapped));
}

/**
 * Any parsed value at all, coerced into usable `Handling`. Never throws: a
 * field that is missing, a string, or wildly out of range becomes the default
 * or the nearest legal value, one field at a time.
 */
export function sanitizeHandling(raw: unknown): Handling {
  const source =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const result: { -readonly [K in keyof Handling]: number } = { ...DEFAULT_HANDLING };
  for (const bound of HANDLING_BOUNDS) {
    result[bound.key] = clampHandlingValue(source[bound.key], bound);
  }
  return result;
}

export function isDefaultHandling(handling: Handling): boolean {
  return HANDLING_BOUNDS.every((bound) => handling[bound.key] === DEFAULT_HANDLING[bound.key]);
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/**
 * What a key does. Everything except `togglePause`, `restart` and `help` is an
 * engine input; those three are intents the composition layer resolves — which
 * of pause and resume applies, whether a restart replays the seed, and what a
 * help panel even is are none of the keyboard's business.
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
  | 'restart'
  | 'help';

/** How an action behaves while its key stays down. */
export type RepeatMode =
  /** Fires once per press. */
  | 'none'
  /** Fires, waits `Handling.dasMs`, then repeats every `Handling.arrMs`. */
  | 'das'
  /** Fires, then repeats every `Handling.softDropMs`. */
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
  { action: 'help', label: 'Help', keys: ['?', 'H'], repeat: 'none' },
];

/** Every action, in the order the default table lists them. */
export const ACTION_IDS: readonly ActionId[] = KEY_BINDINGS.map((binding) => binding.action);

/**
 * What a player's bindings amount to as *data*: which keys each action answers
 * to, and nothing else. Labels and repeat modes are ours, not theirs, so they
 * are never stored — which is what keeps a stored map readable and small.
 */
export type KeyMap = Readonly<Record<ActionId, readonly string[]>>;

const DEFAULT_BY_ACTION: ReadonlyMap<ActionId, KeyBinding> = new Map(
  KEY_BINDINGS.map((binding) => [binding.action, binding] as const),
);

/** The action's name as a player reads it. The one place these words live. */
export function actionLabel(action: ActionId): string {
  return DEFAULT_BY_ACTION.get(action)?.label ?? action;
}

export function actionRepeat(action: ActionId): RepeatMode {
  return DEFAULT_BY_ACTION.get(action)?.repeat ?? 'none';
}

/** The keys the default table gives an action. */
export function defaultKeysFor(action: ActionId): readonly string[] {
  return DEFAULT_BY_ACTION.get(action)?.keys ?? [];
}

export function defaultKeyMap(): KeyMap {
  const map: Record<string, readonly string[]> = {};
  for (const binding of KEY_BINDINGS) {
    map[binding.action] = [...binding.keys];
  }
  return map as KeyMap;
}

/**
 * `KeyboardEvent.key`, normalised for lookup: printable keys are upper-cased
 * so `a` and `A` are the same binding, named keys pass through untouched.
 */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
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
    case 'Meta':
      return 'Cmd';
    default:
      return key;
  }
}

/** A binding's keys as one readable string, e.g. `'← / A'`. */
export function describeBinding(binding: KeyBinding): string {
  return binding.keys.length === 0
    ? 'Unbound'
    : binding.keys.map(formatKeyLabel).join(' / ');
}

/**
 * A key map resolved into the table everything else reads: labels, repeat
 * modes, canonical order, and a key lookup built once.
 *
 * Immutable. Rebinding produces a *new* table rather than mutating this one,
 * which is what makes "the keyboard obeys exactly what it was last handed" a
 * property of the type rather than a promise about call order.
 */
export interface BindingTable {
  readonly list: readonly KeyBinding[];
  readonly map: KeyMap;
  /** The binding for a raw `KeyboardEvent.key`, if there is one. */
  find(key: string): KeyBinding | undefined;
  keys(action: ActionId): readonly string[];
}

export function createBindingTable(map: KeyMap): BindingTable {
  const list: readonly KeyBinding[] = ACTION_IDS.map((action) => ({
    action,
    label: actionLabel(action),
    keys: [...(map[action] ?? [])],
    repeat: actionRepeat(action),
  }));
  const byKey = new Map(
    list.flatMap((binding) => binding.keys.map((key) => [key, binding] as const)),
  );
  return {
    list,
    map,
    find: (key: string) => byKey.get(normalizeKey(key)),
    keys: (action: ActionId) => map[action] ?? [],
  };
}

/** The table a player who has never opened the settings dialog is playing on. */
export const DEFAULT_BINDINGS: BindingTable = createBindingTable(defaultKeyMap());

/** The binding for a raw `KeyboardEvent.key` in the *default* table. */
export function findBinding(key: string): KeyBinding | undefined {
  return DEFAULT_BINDINGS.find(key);
}

// ---------------------------------------------------------------------------
// Editing the bindings
// ---------------------------------------------------------------------------

/**
 * How many keys one action may answer to. Three is generous — the default table
 * never uses more than two — and the cap exists so a row stays a row.
 */
export const MAX_KEYS_PER_ACTION = 3;

/**
 * Actions that must keep at least one key.
 *
 * Without a pause key there is no pause menu, and without a restart key a
 * player who has bound themselves into a corner cannot deal a new game. Either
 * one missing is a player locked out of their own settings.
 */
export const REQUIRED_ACTIONS: readonly ActionId[] = ['togglePause', 'restart'];

/**
 * Keys the capture refuses to record.
 *
 * `Tab` moves between controls, `Enter` presses the one under focus and
 * `Escape` closes the dialog — a capture that swallowed any of them would trap
 * the player inside the very screen meant to set them free. `Alt` and `Meta`
 * belong to the operating system's menus and window manager.
 *
 * `Escape` is on this list but *not* on `UNBINDABLE_KEYS`: the default table
 * gives it to Pause, which is safe because a dialog's own Escape handler stops
 * the key before the game ever sees it. So it may stay where it was put and may
 * be cleared, but it can never be captured onto something else.
 */
export const RESERVED_KEYS: readonly string[] = ['Tab', 'Enter', 'Escape', 'Alt', 'Meta'];

/** Keys no stored map may contain, however it came to contain them. */
export const UNBINDABLE_KEYS: readonly string[] = ['Tab', 'Enter', 'Alt', 'Meta'];

/** Keys that are *themselves* a modifier, and so may be pressed with one held. */
const MODIFIER_KEYS: readonly string[] = ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'];

/** The fields a capture reads off a keyboard event. Nothing else. */
export interface CaptureEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

export type KeyCapture =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Turn a keypress into a bindable key, or say why it is not one.
 *
 * Pure, and therefore the part worth testing: every refusal a player can hit
 * while holding a key down is decided here, in words they can read.
 */
export function captureKey(event: CaptureEvent): KeyCapture {
  const key = normalizeKey(event.key);
  if (key === '' || key === 'Unidentified' || key === 'Dead') {
    return { ok: false, reason: 'That key does not report a name the game can store.' };
  }
  if (RESERVED_KEYS.includes(key)) {
    return {
      ok: false,
      reason: `${formatKeyLabel(key)} is reserved for moving around and closing dialogs, so it cannot be a game key.`,
    };
  }
  const modifierHeld =
    event.ctrlKey === true ||
    event.metaKey === true ||
    event.altKey === true ||
    event.shiftKey === true;
  if (modifierHeld && !MODIFIER_KEYS.includes(key)) {
    return {
      ok: false,
      reason: 'A binding is one key on its own — let go of the modifier so browser and system shortcuts keep working.',
    };
  }
  return { ok: true, key };
}

export type BindResult =
  | { readonly ok: true; readonly map: KeyMap }
  | { readonly ok: false; readonly reason: string };

/** A copy of `map` with `action`'s keys replaced. */
function withKeys(map: KeyMap, action: ActionId, keys: readonly string[]): KeyMap {
  return { ...map, [action]: [...keys] };
}

/** Which action a key already belongs to, if any. */
export function actionForKey(map: KeyMap, key: string): ActionId | null {
  return ACTION_IDS.find((action) => (map[action] ?? []).includes(key)) ?? null;
}

/**
 * Add a key to an action, or refuse and say why.
 *
 * **Conflicts are refused, never stolen.** Taking a key away from another
 * action silently is how a player ends up unable to rotate and with no idea
 * what they did; being told "Space is already Hard drop" costs one more click
 * and never costs a binding.
 */
export function bindKey(map: KeyMap, action: ActionId, rawKey: string): BindResult {
  const key = normalizeKey(rawKey);
  if (UNBINDABLE_KEYS.includes(key) || RESERVED_KEYS.includes(key)) {
    return {
      ok: false,
      reason: `${formatKeyLabel(key)} is reserved for moving around and closing dialogs, so it cannot be a game key.`,
    };
  }
  const owner = actionForKey(map, key);
  if (owner === action) {
    return { ok: false, reason: `${formatKeyLabel(key)} is already ${actionLabel(action)}.` };
  }
  if (owner !== null) {
    return {
      ok: false,
      reason: `${formatKeyLabel(key)} is already ${actionLabel(owner)}. Clear it there first, then try again.`,
    };
  }
  const keys = map[action] ?? [];
  if (keys.length >= MAX_KEYS_PER_ACTION) {
    return {
      ok: false,
      reason: `${actionLabel(action)} already has ${MAX_KEYS_PER_ACTION} keys. Clear one first.`,
    };
  }
  return { ok: true, map: withKeys(map, action, [...keys, key]) };
}

/** Take a key off an action, or refuse and say why. */
export function clearKey(map: KeyMap, action: ActionId, rawKey: string): BindResult {
  const key = normalizeKey(rawKey);
  const keys = map[action] ?? [];
  if (!keys.includes(key)) {
    return { ok: false, reason: `${formatKeyLabel(key)} is not ${actionLabel(action)}.` };
  }
  if (keys.length === 1 && REQUIRED_ACTIONS.includes(action)) {
    return {
      ok: false,
      reason: `${actionLabel(action)} needs at least one key — without it you could not get back to this dialog.`,
    };
  }
  return { ok: true, map: withKeys(map, action, keys.filter((candidate) => candidate !== key)) };
}

/**
 * Put one action back to its defaults, moving whatever else held those keys out
 * of the way. A reset that refused itself over a conflict would be no reset.
 */
export function resetAction(map: KeyMap, action: ActionId): KeyMap {
  const wanted = defaultKeysFor(action);
  const next: Record<string, readonly string[]> = {};
  for (const other of ACTION_IDS) {
    next[other] =
      other === action
        ? [...wanted]
        : (map[other] ?? []).filter((key) => !wanted.includes(key));
  }
  return next as KeyMap;
}

export function isDefaultKeyMap(map: KeyMap): boolean {
  return ACTION_IDS.every((action) => {
    const keys = map[action] ?? [];
    const defaults = defaultKeysFor(action);
    return keys.length === defaults.length && keys.every((key, index) => key === defaults[index]);
  });
}

/**
 * Any parsed value at all → a usable `KeyMap`.
 *
 * Deliberately **all or nothing**: an unknown action, a key bound twice, an
 * action with no keys that must have one, a reserved key, or any shape that is
 * not a record of string arrays gives the whole default table back rather than
 * a half-repaired map. A player whose store was corrupted gets controls they
 * recognise; a player handed a partially-sane map would get controls that are
 * subtly wrong in a way nothing on the screen explains.
 */
export function sanitizeKeyMap(raw: unknown): KeyMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return defaultKeyMap();
  }
  const source = raw as Record<string, unknown>;
  for (const name of Object.keys(source)) {
    if (!(ACTION_IDS as readonly string[]).includes(name)) {
      return defaultKeyMap();
    }
  }

  const seen = new Set<string>();
  const result: Record<string, readonly string[]> = {};
  for (const action of ACTION_IDS) {
    const value = source[action];
    if (!Array.isArray(value) || value.length > MAX_KEYS_PER_ACTION) {
      return defaultKeyMap();
    }
    const keys: string[] = [];
    for (const entry of value as unknown[]) {
      if (typeof entry !== 'string' || entry === '') {
        return defaultKeyMap();
      }
      const key = normalizeKey(entry);
      if (UNBINDABLE_KEYS.includes(key) || seen.has(key)) {
        return defaultKeyMap();
      }
      seen.add(key);
      keys.push(key);
    }
    if (keys.length === 0 && REQUIRED_ACTIONS.includes(action)) {
      return defaultKeyMap();
    }
    result[action] = keys;
  }
  return result as KeyMap;
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
 *
 * An `intervalMs` of zero is the player asking for "instant" and is answered
 * with a full frame's worth of steps — see `HANDLING_BOUNDS` for why that is
 * offered sideways and not downwards.
 */
export function stepRepeat(
  state: RepeatState,
  deltaMs: number,
  delayMs: number,
  intervalMs: number,
): { readonly state: RepeatState; readonly repeats: number } {
  if (!(deltaMs > 0) || !Number.isFinite(intervalMs) || intervalMs < 0) {
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

  if (intervalMs === 0) {
    return { state: { elapsedMs: 0, charged }, repeats: MAX_REPEATS_PER_FRAME };
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
// The shared auto-repeat clock
// ---------------------------------------------------------------------------

/**
 * A press-and-hold driver: the part of "holding left" that is not about
 * keyboards at all.
 *
 * Whatever is pressed fires once immediately. Left and right then charge DAS
 * and stream at ARR, soft drop repeats at its own steadier rate, and every
 * other action stays a single shot. Holding both directions at once keeps the
 * most recently pressed one, and releasing it hands over to the other with a
 * fresh DAS charge so the piece does not warp across the well.
 *
 * The keyboard and the on-screen pad each own an instance. They cannot fight
 * over one shared hold state, and they cannot drift apart on timing either —
 * they are handed the same `handling` accessor, and read it every frame, so a
 * slider moved mid-run is felt on the next one.
 */
export interface AutoRepeat {
  /** Begin holding an action. Emits once now; returns `false` if already held. */
  press(action: ActionId): boolean;
  release(action: ActionId): void;
  releaseAll(): void;
  /** Drive repeats. Call once per frame with the real elapsed time. */
  update(deltaMs: number): void;
  isHeld(action: ActionId): boolean;
}

export function createAutoRepeat(
  emit: (action: ActionId) => void,
  handling: () => Handling = () => DEFAULT_HANDLING,
): AutoRepeat {
  /** Actions currently held down. */
  const held = new Set<ActionId>();
  /** The direction that owns auto-repeat: the most recently pressed one. */
  let activeDirection: 'moveLeft' | 'moveRight' | null = null;
  let horizontalRepeat: RepeatState = FRESH_REPEAT;
  let softRepeat: RepeatState = FRESH_REPEAT;

  function releaseAll(): void {
    held.clear();
    activeDirection = null;
    horizontalRepeat = FRESH_REPEAT;
    softRepeat = FRESH_REPEAT;
  }

  return {
    press(action: ActionId): boolean {
      if (held.has(action)) {
        return false;
      }
      held.add(action);

      if (action === 'moveLeft' || action === 'moveRight') {
        activeDirection = action;
        horizontalRepeat = FRESH_REPEAT;
      } else if (action === 'softDrop') {
        softRepeat = FRESH_REPEAT;
      }

      emit(action);
      return true;
    },

    release(action: ActionId): void {
      held.delete(action);

      if (action === activeDirection) {
        const other = action === 'moveLeft' ? 'moveRight' : 'moveLeft';
        activeDirection = held.has(other) ? other : null;
        horizontalRepeat = FRESH_REPEAT;
      }
    },

    releaseAll,

    update(deltaMs: number): void {
      const timing = handling();
      if (activeDirection !== null) {
        const stepped = stepRepeat(horizontalRepeat, deltaMs, timing.dasMs, timing.arrMs);
        horizontalRepeat = stepped.state;
        for (let i = 0; i < stepped.repeats; i += 1) {
          emit(activeDirection);
        }
      }
      if (held.has('softDrop')) {
        const stepped = stepRepeat(softRepeat, deltaMs, timing.softDropMs, timing.softDropMs);
        softRepeat = stepped.state;
        for (let i = 0; i < stepped.repeats; i += 1) {
          emit('softDrop');
        }
      }
    },

    isHeld(action: ActionId): boolean {
      return held.has(action);
    },
  };
}

// ---------------------------------------------------------------------------
// The live bindings
// ---------------------------------------------------------------------------

/**
 * The bindings and handling in force, as one object everything reads through.
 *
 * The store is *handed in* rather than reached for, the way `ui/motion.ts`
 * takes its one setting, so the runtime dependency runs into `ui/storage.ts`
 * and never back out. `listen` is how the help panel, the controls card and the
 * on-screen pad find out a key moved — there is no other copy of the list to
 * update, only views of this one.
 */
export interface LiveBindings {
  table(): BindingTable;
  handling(): Handling;
  /** Replace the whole map. Sanitised, persisted, and published to listeners. */
  setKeyMap(map: KeyMap): void;
  setHandling(handling: Handling): void;
  /** Subscribe to changes; returns the unsubscribe. */
  listen(listener: () => void): () => void;
}

export interface LiveBindingsOptions {
  readonly keys?: SettingAccess<KeyMap>;
  readonly handling?: SettingAccess<Handling>;
}

export function createLiveBindings(options: LiveBindingsOptions = {}): LiveBindings {
  let table = createBindingTable(sanitizeKeyMap(options.keys?.read()));
  let timing = sanitizeHandling(options.handling?.read());
  const listeners = new Set<() => void>();

  function publish(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    table: () => table,
    handling: () => timing,

    setKeyMap(map: KeyMap): void {
      table = createBindingTable(sanitizeKeyMap(map));
      options.keys?.write(table.map);
      publish();
    },

    setHandling(next: Handling): void {
      timing = sanitizeHandling(next);
      options.handling?.write(timing);
      publish();
    },

    listen(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ---------------------------------------------------------------------------
// The keyboard controller
// ---------------------------------------------------------------------------

export interface KeyboardInputOptions {
  /** Called once per press and once per auto-repeat. */
  readonly onAction: (action: ActionId) => void;
  /**
   * The bindings in force, read per keypress. Left out, the defaults apply —
   * which is what the tests want and what a build with no settings UI would do.
   */
  readonly bindings?: () => BindingTable;
  /** The repeat timing in force, read per frame. */
  readonly handling?: () => Handling;
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

/**
 * Does this key belong to something other than the game?
 *
 * Two cases. A control with focus owns its own keys — space on a button is a
 * press, not a hard drop. And **anything inside an open dialog belongs to the
 * dialog**: the pause menu, the help panel and the settings dialog are modal,
 * so while one is up every key is theirs, right down to the arrows that scroll
 * a long panel. Without that second rule the game would eat the scroll.
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) {
    return false;
  }
  if (INTERACTIVE_TAGS.has(target.tagName) || target.isContentEditable) {
    return true;
  }
  return target.closest('[role="dialog"]') !== null;
}

/**
 * Start listening. Returns a handle whose `update` must be called from the
 * game loop — without it, keys fire once and never repeat.
 */
export function createKeyboardInput(options: KeyboardInputOptions): KeyboardInput {
  const target = options.target ?? window;
  const bindings = options.bindings ?? (() => DEFAULT_BINDINGS);
  const repeat = createAutoRepeat(options.onAction, options.handling);

  function onKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || event.defaultPrevented) {
      return;
    }
    // A shortcut is being typed (Cmd+R, Alt+Tab, Ctrl+F): stay out of the way.
    // `Control` itself is bindable, so it is the one ctrl-ish key we accept.
    if (event.metaKey || event.altKey) {
      return;
    }
    if (event.ctrlKey && normalizeKey(event.key) !== 'Control') {
      return;
    }
    if (isInteractiveTarget(event.target)) {
      return;
    }

    const binding = bindings().find(event.key);
    if (binding === undefined) {
      return;
    }

    // Prevented even for OS repeats, so holding an arrow never scrolls.
    event.preventDefault();
    if (event.repeat) {
      return;
    }
    repeat.press(binding.action);
  }

  function onKeyUp(event: Event): void {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    // Released unconditionally — including with a modifier down, which is how a
    // key that went down before Cmd was pressed avoids getting stuck on.
    const binding = bindings().find(event.key);
    if (binding !== undefined) {
      repeat.release(binding.action);
    }
  }

  function releaseAll(): void {
    repeat.releaseAll();
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', releaseAll);

  return {
    update(deltaMs: number): void {
      repeat.update(deltaMs);
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
