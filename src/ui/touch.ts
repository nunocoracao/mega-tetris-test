/**
 * Touch input: gestures over the well, and an on-screen button pad.
 *
 * Two complementary paths, because two kinds of player show up on a phone.
 * The one who wants the game to feel physical drags the piece around with a
 * thumb; the one who wants to know exactly what they pressed uses the pad.
 * Both funnel into the same small vocabulary of actions — a subset of the
 * keyboard's `ActionId` and of the engine's `GameInput`, so neither consumer
 * needs a translation table.
 *
 * The file is deliberately split in two halves:
 *
 *  - `createGestureRecognizer` is **pure**. It takes plain `{pointerId, x, y,
 *    timeMs}` records and returns the actions they mean. No DOM, no clock, no
 *    element lookups — which is what makes the feel of the gestures testable
 *    instead of something you can only assess by waving a finger at a laptop.
 *  - `createTouchControls` is the browser half: Pointer Events, pointer
 *    capture, `preventDefault`, the pad's press-and-hold, and the stored
 *    visibility preference. It reads the rendered cell size off the canvas and
 *    hands it to the recogniser, and it borrows `createAutoRepeat` from
 *    `./input` so a held button and a held key repeat identically.
 */

import { BOARD_HEIGHT, BOARD_WIDTH, type GameInput } from '../engine';
import { createAutoRepeat, type ActionId } from './input';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Everything touch can ask for. Typed as the intersection of the keyboard's
 * action ids and the engine's input types, which is the compile-time proof
 * that a touch action can be handed to either without a conversion.
 */
export const TOUCH_ACTIONS = [
  'moveLeft',
  'moveRight',
  'softDrop',
  'hardDrop',
  'rotateCW',
  'rotateCCW',
  'hold',
] as const satisfies readonly (ActionId & GameInput['type'])[];

export type TouchAction = (typeof TOUCH_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Gesture tuning
// ---------------------------------------------------------------------------
//
// Every distance below is a multiple of the *rendered cell size* rather than a
// pixel count. A cell is roughly a thumb-width fraction of the well on any
// screen, so expressing thresholds in cells is what makes the same gesture
// feel the same on a 320px phone and a 1024px tablet.

/**
 * Sideways drag per column moved. A little under a full cell, so the piece
 * tracks slightly ahead of the thumb — at exactly one cell it feels like it is
 * dragging its heels, and much below half it skitters.
 */
export const MOVE_STEP_CELLS = 0.62;

/**
 * Downward drag per soft-dropped row. Longer than the sideways step because an
 * accidental row of drop costs more than an accidental column of shift.
 */
export const SOFT_DROP_STEP_CELLS = 0.8;

/**
 * How far a finger may wander and still count as a tap. Half a cell is about
 * ten pixels on a phone: comfortably above finger jitter, comfortably below a
 * deliberate nudge, and below `MOVE_STEP_CELLS` so the axis always locks first.
 */
export const TAP_SLOP_CELLS = 0.5;

/** Longer than this and a still finger is resting on the glass, not tapping. */
export const TAP_MAX_MS = 260;

/**
 * A downward flick must cross this many rows before it can mean "slam". Two
 * rows and a bit is further than anyone flicks by accident while soft dropping.
 */
export const HARD_DROP_MIN_CELLS = 2.2;

/**
 * ...and must still be moving this fast when it does — cells per millisecond,
 * so 0.045 is about forty-five rows a second. A deliberate soft drag is an
 * order of magnitude slower, which keeps the two gestures from bleeding.
 */
export const HARD_DROP_MIN_SPEED = 0.045;

/**
 * Speed is measured over the tail of the drag rather than all of it, so a slow
 * descent that ends in a flick still reads as a flick.
 */
export const VELOCITY_WINDOW_MS = 70;

/**
 * Upward swipe that means hold. Well past the move step, because a hold is
 * expensive to undo and a sideways drag with a hopeful curve to it should not
 * trigger one.
 */
export const HOLD_SWIPE_CELLS = 1.6;

/**
 * Taps in this leftmost slice of the well rotate counter-clockwise; taps
 * anywhere else rotate clockwise. Narrow enough that the common rotation stays
 * the whole-field gesture it should be.
 */
export const CCW_ZONE_FRACTION = 0.2;

/**
 * Ceiling on the moves one pointer event may emit. Only bites when a pointer
 * event arrives after a long stall carrying a huge jump; flooding the engine
 * with a dozen queued moves is worse than dropping the surplus.
 */
const MAX_STEPS_PER_EVENT = 12;

/**
 * A hair of slack on every threshold comparison. The anchor advances by adding
 * the step repeatedly, so a drag of exactly three steps lands a billionth of a
 * pixel short of the third — visible to `>=`, invisible to a thumb. Without it
 * a steady drag can stall on a boundary.
 */
const EPSILON = 1e-6;

// ---------------------------------------------------------------------------
// The gesture recogniser (pure)
// ---------------------------------------------------------------------------

/** The fields the recogniser reads off a pointer event. Nothing else. */
export interface GesturePointer {
  readonly pointerId: number;
  /** Position in surface-local pixels: `0,0` is the top-left of the well. */
  readonly x: number;
  readonly y: number;
  /** A monotonic timestamp in milliseconds. Only differences are used. */
  readonly timeMs: number;
}

/** What the recogniser needs to know about the thing being touched. */
export interface GestureSurface {
  /** Side of one rendered board cell, in CSS pixels. Scales every threshold. */
  readonly cellSize: number;
  /** Width of the play surface, in CSS pixels — sets the rotate-CCW zone. */
  readonly width: number;
}

export interface GestureRecognizer {
  down(pointer: GesturePointer): readonly TouchAction[];
  move(pointer: GesturePointer): readonly TouchAction[];
  up(pointer: GesturePointer): readonly TouchAction[];
  /** The gesture is abandoned: forget it without emitting anything. */
  cancel(pointer: GesturePointer): readonly TouchAction[];
  /** Re-measure after a resize or a rotation. */
  setSurface(surface: GestureSurface): void;
  /** True while a primary pointer is being followed. */
  isTracking(): boolean;
}

const NO_ACTIONS: readonly TouchAction[] = [];

/** One position in time, kept only long enough to measure the tail velocity. */
interface Sample {
  readonly y: number;
  readonly t: number;
}

/** The primary pointer's journey so far. */
interface Gesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
  /** Where the next step is measured from; advances one threshold at a time. */
  anchorX: number;
  anchorY: number;
  /** Locked on the first movement past the slop, and never revisited. */
  axis: 'x' | 'y' | null;
  /** A hard drop or a hold has resolved this gesture; ignore the rest of it. */
  spent: boolean;
  /** A second finger touched down at some point during the gesture. */
  multiTouch: boolean;
  samples: Sample[];
}

function sanitize(surface: GestureSurface): GestureSurface {
  const cellSize = Number.isFinite(surface.cellSize) && surface.cellSize > 0 ? surface.cellSize : 1;
  const width = Number.isFinite(surface.width) && surface.width > 0 ? surface.width : 1;
  return { cellSize, width };
}

/**
 * Speed of the last stretch of the drag, in pixels per millisecond, measured
 * from the oldest sample still inside the velocity window. A finger that has
 * come to rest has no sample in the window and so reports a speed close to
 * zero — which is exactly what stops "drag down, pause, lift" slamming.
 */
function tailSpeed(samples: readonly Sample[], now: Sample): number {
  let anchor: Sample | undefined;
  for (const sample of samples) {
    if (now.t - sample.t <= VELOCITY_WINDOW_MS) {
      anchor = sample;
      break;
    }
  }
  anchor ??= samples[samples.length - 1];
  if (anchor === undefined) {
    return 0;
  }
  const dt = now.t - anchor.t;
  return dt > 0 ? (now.y - anchor.y) / dt : 0;
}

/**
 * Turn a stream of pointer positions into game actions.
 *
 * One primary pointer at a time: the first finger down owns the gesture and
 * later fingers only mark it as a multi-touch (which is what turns a tap into
 * a counter-clockwise rotation). That is deliberate — the on-screen pad lives
 * in its own elements, so a second thumb on a button never reaches here and
 * never disturbs a drag in progress.
 */
export function createGestureRecognizer(initial: GestureSurface): GestureRecognizer {
  let surface = sanitize(initial);
  let gesture: Gesture | null = null;
  const secondary = new Set<number>();

  /** Every threshold, resolved against the current cell size. */
  function thresholds() {
    const cell = surface.cellSize;
    return {
      move: MOVE_STEP_CELLS * cell,
      /** What a step has to beat: the step itself, less floating-point drift. */
      moveDue: MOVE_STEP_CELLS * cell - EPSILON,
      soft: SOFT_DROP_STEP_CELLS * cell,
      softDue: SOFT_DROP_STEP_CELLS * cell - EPSILON,
      slop: TAP_SLOP_CELLS * cell,
      hardDistance: HARD_DROP_MIN_CELLS * cell - EPSILON,
      hardSpeed: HARD_DROP_MIN_SPEED * cell - EPSILON,
      hold: HOLD_SWIPE_CELLS * cell - EPSILON,
    };
  }

  function forget(): void {
    gesture = null;
    secondary.clear();
  }

  return {
    down(pointer: GesturePointer): readonly TouchAction[] {
      if (gesture !== null) {
        // A second finger. It cannot steer, but it does change what a tap means.
        if (pointer.pointerId !== gesture.pointerId) {
          gesture.multiTouch = true;
          secondary.add(pointer.pointerId);
        }
        return NO_ACTIONS;
      }

      gesture = {
        pointerId: pointer.pointerId,
        startX: pointer.x,
        startY: pointer.y,
        startTime: pointer.timeMs,
        anchorX: pointer.x,
        anchorY: pointer.y,
        axis: null,
        spent: false,
        multiTouch: false,
        samples: [{ y: pointer.y, t: pointer.timeMs }],
      };
      return NO_ACTIONS;
    },

    move(pointer: GesturePointer): readonly TouchAction[] {
      const active = gesture;
      if (active === null || pointer.pointerId !== active.pointerId || active.spent) {
        return NO_ACTIONS;
      }

      active.samples.push({ y: pointer.y, t: pointer.timeMs });
      if (active.samples.length > 12) {
        active.samples.shift();
      }

      const limits = thresholds();
      const dx = pointer.x - active.startX;
      const dy = pointer.y - active.startY;

      if (active.axis === null) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < limits.slop) {
          return NO_ACTIONS;
        }
        // Locked once and never revisited: a drag that curves must not start
        // dropping the piece halfway through a sideways move.
        active.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }

      const actions: TouchAction[] = [];

      if (active.axis === 'x') {
        while (
          pointer.x - active.anchorX >= limits.moveDue &&
          actions.length < MAX_STEPS_PER_EVENT
        ) {
          active.anchorX += limits.move;
          actions.push('moveRight');
        }
        while (
          active.anchorX - pointer.x >= limits.moveDue &&
          actions.length < MAX_STEPS_PER_EVENT
        ) {
          active.anchorX -= limits.move;
          actions.push('moveLeft');
        }
        return actions;
      }

      if (dy < 0) {
        if (-dy >= limits.hold) {
          active.spent = true;
          return ['hold'];
        }
        return NO_ACTIONS;
      }

      // Downwards. A flick that is both long enough and still fast enough is a
      // slam, resolved the instant it qualifies rather than on release — the
      // player should see the piece land while their finger is still moving.
      const speed = tailSpeed(active.samples, { y: pointer.y, t: pointer.timeMs });
      if (dy >= limits.hardDistance && speed >= limits.hardSpeed) {
        active.spent = true;
        return ['hardDrop'];
      }

      while (
        pointer.y - active.anchorY >= limits.softDue &&
        actions.length < MAX_STEPS_PER_EVENT
      ) {
        active.anchorY += limits.soft;
        actions.push('softDrop');
      }
      return actions;
    },

    up(pointer: GesturePointer): readonly TouchAction[] {
      if (secondary.delete(pointer.pointerId)) {
        return NO_ACTIONS;
      }
      const active = gesture;
      if (active === null || pointer.pointerId !== active.pointerId) {
        return NO_ACTIONS;
      }
      forget();

      if (active.spent) {
        return NO_ACTIONS;
      }

      const limits = thresholds();

      if (active.axis === null) {
        // Never moved past the slop: a tap, if it was brief enough.
        if (pointer.timeMs - active.startTime > TAP_MAX_MS) {
          return NO_ACTIONS;
        }
        const counterClockwise =
          active.multiTouch || active.startX < surface.width * CCW_ZONE_FRACTION;
        return [counterClockwise ? 'rotateCCW' : 'rotateCW'];
      }

      if (active.axis === 'y') {
        // A flick released before `move` caught it — short, sharp, and gone.
        const now = { y: pointer.y, t: pointer.timeMs };
        active.samples.push(now);
        const dy = pointer.y - active.startY;
        if (dy >= limits.hardDistance && tailSpeed(active.samples, now) >= limits.hardSpeed) {
          return ['hardDrop'];
        }
      }

      return NO_ACTIONS;
    },

    cancel(pointer: GesturePointer): readonly TouchAction[] {
      if (secondary.delete(pointer.pointerId)) {
        return NO_ACTIONS;
      }
      if (gesture !== null && pointer.pointerId === gesture.pointerId) {
        forget();
      }
      return NO_ACTIONS;
    },

    setSurface(next: GestureSurface): void {
      surface = sanitize(next);
    },

    isTracking(): boolean {
      return gesture !== null;
    },
  };
}

// ---------------------------------------------------------------------------
// The on-screen pad, as data
// ---------------------------------------------------------------------------

export interface PadButton {
  readonly action: TouchAction;
  /** The button's accessible name. */
  readonly label: string;
  /** The cap's face. Decorative — `label` is what a screen reader says. */
  readonly glyph: string;
  /** Grid area, so the stylesheet lays the pad out rather than the markup. */
  readonly slot: string;
}

/**
 * The pad, top row then bottom row. `shell.ts` builds the markup from this
 * table and `createTouchControls` wires it, so adding a button is one edit.
 */
export const TOUCH_PAD_BUTTONS: readonly PadButton[] = [
  { action: 'hold', label: 'Hold piece', glyph: '⇄', slot: 'hold' },
  { action: 'rotateCCW', label: 'Rotate left', glyph: '↺', slot: 'ccw' },
  { action: 'rotateCW', label: 'Rotate right', glyph: '↻', slot: 'cw' },
  { action: 'hardDrop', label: 'Hard drop', glyph: '⇓', slot: 'hard' },
  { action: 'moveLeft', label: 'Move left', glyph: '◀', slot: 'left' },
  { action: 'softDrop', label: 'Soft drop', glyph: '▼', slot: 'soft' },
  { action: 'moveRight', label: 'Move right', glyph: '▶', slot: 'right' },
];

// ---------------------------------------------------------------------------
// The pad visibility preference (pure helpers + storage)
// ---------------------------------------------------------------------------

/** `auto` shows the pad on touch-capable or narrow screens; the rest are the
 *  player overriding that guess in either direction. */
export type PadPreference = 'auto' | 'on' | 'off';

export const PAD_PREFERENCES: readonly PadPreference[] = ['auto', 'on', 'off'];

export const PAD_PREFERENCE_KEY = 'mega-tetris:touch-pad';

/** Anything unrecognised — absent, corrupt, from a future version — is `auto`. */
export function parsePadPreference(raw: string | null | undefined): PadPreference {
  return PAD_PREFERENCES.find((value) => value === raw) ?? 'auto';
}

/** The cycle the toggle button walks: auto → on → off → auto. */
export function nextPadPreference(current: PadPreference): PadPreference {
  const index = PAD_PREFERENCES.indexOf(current);
  return PAD_PREFERENCES[(index + 1) % PAD_PREFERENCES.length] ?? 'auto';
}

export function padPreferenceLabel(preference: PadPreference): string {
  switch (preference) {
    case 'auto':
      return 'Auto';
    case 'on':
      return 'On';
    case 'off':
      return 'Off';
  }
}

/** Whether the pad shows, given the preference and whether this looks like a
 *  touch device. The one rule the setting exists to override. */
export function isPadVisible(preference: PadPreference, touchLikely: boolean): boolean {
  switch (preference) {
    case 'on':
      return true;
    case 'off':
      return false;
    case 'auto':
      return touchLikely;
  }
}

/** Storage is a nicety, not a requirement: Safari's private mode throws. */
function readStoredPreference(): PadPreference {
  try {
    return parsePadPreference(localStorage.getItem(PAD_PREFERENCE_KEY));
  } catch {
    return 'auto';
  }
}

function writeStoredPreference(preference: PadPreference): void {
  try {
    localStorage.setItem(PAD_PREFERENCE_KEY, preference);
  } catch {
    // A player with storage disabled simply gets the default next visit.
  }
}

// ---------------------------------------------------------------------------
// Haptics
// ---------------------------------------------------------------------------

/** A lock is a tick, not a buzz: short enough to feel like the piece landing. */
export const HAPTIC_LOCK_MS = 12;

/** A clear gets two beats, so it is distinguishable from a lock by feel alone. */
export const HAPTIC_CLEAR_PATTERN: readonly number[] = [0, 22, 45, 30];

export interface Haptics {
  lock(): void;
  clear(): void;
}

/**
 * Light vibration on lock and line clear, on the devices that have it.
 *
 * Guarded three ways: the API may not exist, the document may not be visible
 * (browsers reject the call anyway, and buzzing a backgrounded tab is rude),
 * and a player who has asked for reduced motion has asked not to be shaken —
 * there is no sound or haptics setting of our own to consult yet, so the
 * platform preference stands in for one.
 */
export function createHaptics(): Haptics {
  const supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  const calm =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  function buzz(pattern: number | readonly number[]): void {
    if (!supported || calm?.matches === true || document.hidden) {
      return;
    }
    navigator.vibrate(typeof pattern === 'number' ? pattern : [...pattern]);
  }

  return {
    lock: () => buzz(HAPTIC_LOCK_MS),
    clear: () => buzz(HAPTIC_CLEAR_PATTERN),
  };
}

// ---------------------------------------------------------------------------
// The browser controller
// ---------------------------------------------------------------------------

/**
 * When `auto` shows the pad: a coarse pointer (a finger) or a screen narrow
 * enough that a keyboard is unlikely to be attached to it.
 */
const TOUCH_LIKELY_QUERY = '(pointer: coarse), (max-width: 48rem)';

export interface TouchControlsOptions {
  /** The element gestures are read from — the playfield wrapper. */
  readonly surface: HTMLElement;
  /** The board canvas, whose box gives the rendered cell size. */
  readonly boardCanvas: HTMLElement;
  /** The pad container built by the shell. */
  readonly pad: HTMLElement;
  /** The button that cycles the pad preference. */
  readonly padToggle: HTMLButtonElement;
  readonly onAction: (action: TouchAction) => void;
  /** Called only when the *player* changes the setting, never on startup. */
  readonly onPreferenceChange?: (preference: PadPreference, visible: boolean) => void;
}

export interface TouchControls {
  /** Drive the pad's press-and-hold. Call once per frame from the game loop. */
  update(deltaMs: number): void;
  /** Forget every held button and any gesture in flight. */
  releaseAll(): void;
  preference(): PadPreference;
  padVisible(): boolean;
  /** True when this looks like a touch device, whatever the pad setting says. */
  touchLikely(): boolean;
  destroy(): void;
}

/** Presses that belong to a control, not to the field underneath it. */
function isControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, a, input, select, textarea') !== null;
}

/**
 * Pointer capture, best effort.
 *
 * Both calls throw `NotFoundError` for a pointer the browser no longer
 * considers active — a touch that ended between the event being queued and the
 * handler running, or a synthesised event. Capture is an improvement (a drag
 * that leaves the well keeps steering it), never a requirement, so a failure
 * must not take the press down with it.
 */
function capture(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Without capture the gesture still works; it just ends at the boundary.
  }
}

function uncapture(element: Element, pointerId: number): void {
  try {
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  } catch {
    // Already released, or never held. Either way there is nothing to do.
  }
}

export function createTouchControls(options: TouchControlsOptions): TouchControls {
  const { surface, boardCanvas, pad, padToggle } = options;

  const recognizer = createGestureRecognizer(measureSurface());
  // The pad borrows the keyboard's repeat clock rather than owning a second
  // one, which is what makes a held ◀ feel exactly like a held arrow key.
  const repeat = createAutoRepeat((action) => options.onAction(action as TouchAction));

  const touchQuery = typeof matchMedia === 'function' ? matchMedia(TOUCH_LIKELY_QUERY) : null;
  let preference = readStoredPreference();

  /** Rect of the play surface, re-read whenever a gesture starts. */
  let rect = surface.getBoundingClientRect();
  /** The pointer currently driving gestures, so pointer capture can be undone. */
  let capturedPointer: number | null = null;

  function measureSurface(): GestureSurface {
    const width = boardCanvas.clientWidth;
    const height = boardCanvas.clientHeight;
    // The renderer fits a 10x22 grid of square cells into the canvas box; the
    // limiting dimension decides the cell, exactly as `computeGridLayout` does.
    const cellSize = Math.min(width / BOARD_WIDTH, height / BOARD_HEIGHT);
    return { cellSize, width: width > 0 ? width : 1 };
  }

  function emitAll(actions: readonly TouchAction[]): void {
    for (const action of actions) {
      options.onAction(action);
    }
  }

  // -- gestures ------------------------------------------------------------

  /** Mice keep their old meaning: clicking the well should not spin the piece. */
  function isGesturePointer(event: PointerEvent): boolean {
    return event.pointerType !== 'mouse';
  }

  function toPointer(event: PointerEvent): GesturePointer {
    return {
      pointerId: event.pointerId,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      timeMs: event.timeStamp,
    };
  }

  function onPointerDown(event: PointerEvent): void {
    if (!isGesturePointer(event) || isControlTarget(event.target)) {
      return;
    }
    // Measured now rather than on a resize observer: a gesture is the only
    // moment the numbers matter, and one rect read per touch is free.
    rect = surface.getBoundingClientRect();
    recognizer.setSurface(measureSurface());

    // Stops the page scrolling, pinch-zooming or pulling to refresh mid-drag.
    // `touch-action: none` in the stylesheet does the same job ahead of time;
    // this is the belt to its braces, and also kills the long-press callout.
    event.preventDefault();

    if (capturedPointer === null) {
      capturedPointer = event.pointerId;
      // Capture so a drag that leaves the well keeps steering it.
      capture(surface, event.pointerId);
    }
    emitAll(recognizer.down(toPointer(event)));
  }

  function onPointerMove(event: PointerEvent): void {
    if (!isGesturePointer(event) || !recognizer.isTracking()) {
      return;
    }
    event.preventDefault();
    emitAll(recognizer.move(toPointer(event)));
  }

  function releaseCapture(pointerId: number): void {
    if (capturedPointer === pointerId) {
      capturedPointer = null;
      uncapture(surface, pointerId);
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (!isGesturePointer(event)) {
      return;
    }
    emitAll(recognizer.up(toPointer(event)));
    releaseCapture(event.pointerId);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (!isGesturePointer(event)) {
      return;
    }
    recognizer.cancel(toPointer(event));
    releaseCapture(event.pointerId);
  }

  // -- the pad -------------------------------------------------------------

  const padButtons = [...pad.querySelectorAll<HTMLButtonElement>('[data-pad-action]')];

  function actionOf(button: HTMLButtonElement): TouchAction | null {
    const raw = button.dataset['padAction'];
    return TOUCH_ACTIONS.find((action) => action === raw) ?? null;
  }

  function onPadPointerDown(event: PointerEvent): void {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const action = actionOf(button);
    if (action === null) {
      return;
    }
    // No `preventDefault` here: the button should still take focus and still
    // synthesise its click, so the control behaves like the button it is.
    // `touch-action: manipulation` in the stylesheet is what removes the tap
    // delay, and `user-select: none` is what stops the press selecting text.
    //
    // Captured so the release is heard even if the thumb slides off the cap —
    // otherwise a button dragged away from stays held down for ever.
    capture(button, event.pointerId);
    repeat.press(action);
  }

  function onPadPointerUp(event: PointerEvent): void {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const action = actionOf(button);
    if (action !== null) {
      repeat.release(action);
    }
  }

  /**
   * Keyboard activation of a pad button. A click synthesised from Enter or
   * Space carries `detail === 0`, which is how it is told apart from the click
   * that follows a real press — the press path has already fired that one.
   */
  function onPadClick(event: MouseEvent): void {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement) || event.detail !== 0) {
      return;
    }
    const action = actionOf(button);
    if (action !== null) {
      options.onAction(action);
    }
  }

  for (const button of padButtons) {
    button.addEventListener('pointerdown', onPadPointerDown);
    button.addEventListener('pointerup', onPadPointerUp);
    button.addEventListener('pointercancel', onPadPointerUp);
    button.addEventListener('lostpointercapture', onPadPointerUp);
    button.addEventListener('click', onPadClick);
  }

  // -- visibility ----------------------------------------------------------

  function touchLikely(): boolean {
    return touchQuery?.matches ?? false;
  }

  function padVisible(): boolean {
    return isPadVisible(preference, touchLikely());
  }

  function applyPreference(): void {
    const visible = padVisible();
    pad.hidden = !visible;
    // A root attribute rather than a class on the pad, because the layout has
    // to react too: the field's height cap shrinks and the keyboard help — of
    // no use to a thumb — gets out of the way.
    document.documentElement.dataset['touchPad'] = visible ? 'on' : 'off';
    padToggle.textContent = `Touchpad: ${padPreferenceLabel(preference)}`;
    padToggle.title =
      preference === 'auto'
        ? 'On-screen controls follow the device. Tap to force them on or off.'
        : `On-screen controls forced ${padPreferenceLabel(preference).toLowerCase()}. Tap to change.`;
    if (!visible) {
      repeat.releaseAll();
    }
  }

  function onToggleClick(): void {
    preference = nextPadPreference(preference);
    writeStoredPreference(preference);
    applyPreference();
    options.onPreferenceChange?.(preference, padVisible());
  }

  function onQueryChange(): void {
    applyPreference();
  }

  // -- wiring --------------------------------------------------------------

  /** Long-press callouts and text selection have no business on a game board. */
  function onContextMenu(event: Event): void {
    event.preventDefault();
  }

  surface.addEventListener('pointerdown', onPointerDown, { passive: false });
  surface.addEventListener('pointermove', onPointerMove, { passive: false });
  surface.addEventListener('pointerup', onPointerUp);
  surface.addEventListener('pointercancel', onPointerCancel);
  surface.addEventListener('contextmenu', onContextMenu);
  pad.addEventListener('contextmenu', onContextMenu);
  padToggle.addEventListener('click', onToggleClick);
  touchQuery?.addEventListener('change', onQueryChange);

  applyPreference();

  return {
    update(deltaMs: number): void {
      repeat.update(deltaMs);
    },
    releaseAll(): void {
      repeat.releaseAll();
      if (capturedPointer !== null) {
        recognizer.cancel({ pointerId: capturedPointer, x: 0, y: 0, timeMs: 0 });
        releaseCapture(capturedPointer);
      }
    },
    preference: () => preference,
    padVisible,
    touchLikely,
    destroy(): void {
      repeat.releaseAll();
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onPointerCancel);
      surface.removeEventListener('contextmenu', onContextMenu);
      pad.removeEventListener('contextmenu', onContextMenu);
      padToggle.removeEventListener('click', onToggleClick);
      touchQuery?.removeEventListener('change', onQueryChange);
      for (const button of padButtons) {
        button.removeEventListener('pointerdown', onPadPointerDown);
        button.removeEventListener('pointerup', onPadPointerUp);
        button.removeEventListener('pointercancel', onPadPointerUp);
        button.removeEventListener('lostpointercapture', onPadPointerUp);
        button.removeEventListener('click', onPadClick);
      }
    },
  };
}
