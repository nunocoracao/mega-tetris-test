/**
 * The cabinet's voice.
 *
 * Every sound in the game is synthesised on the spot from oscillators and gain
 * envelopes — there is not a single audio file in the repository, and there is
 * nothing to license, download or wait for. A cue is a handful of short tones,
 * each one a frequency glide under an attack/decay envelope, and the whole
 * vocabulary fits in the `CUES` table below.
 *
 * The interesting half is pure. `cueTones` turns a cue (and, for a line clear,
 * how many rows went) into a list of `ToneSpec`s — plain data, no Web Audio, no
 * clock — so the musical decisions ("a quad is a fifth above a single") are
 * unit-testable. The player is the thin part: it walks that list and schedules
 * one oscillator per tone.
 *
 * Two browser realities shape the rest. An `AudioContext` created before a user
 * gesture starts life suspended and counts against the page, so we do not build
 * one until the player touches something. And a context can be suspended again
 * at any time (tab switches, iOS), so every cue re-checks and asks for a resume
 * rather than assuming.
 *
 * The mute is persisted, but not by this file: `ui/storage.ts` owns the one key
 * the game writes and `src/main.ts` hands over the single setting. The type
 * import below is erased at build time, so the runtime dependency runs one way.
 */

import type { SettingAccess } from './storage';

/** One oscillator's worth of sound. */
export interface ToneSpec {
  readonly wave: OscillatorType;
  /** Frequency at the start of the tone, in hertz. */
  readonly startHz: number;
  /** Frequency at the end — equal to `startHz` for a flat tone. */
  readonly endHz: number;
  /** How long after the cue starts this tone begins. */
  readonly delayMs: number;
  readonly durationMs: number;
  /** Peak of the envelope, relative to the master volume. 0..1. */
  readonly gain: number;
}

/** Everything the game can say. */
export type SoundCue =
  | 'move'
  | 'rotate'
  | 'softDrop'
  | 'hardDrop'
  | 'lock'
  | 'clear'
  | 'levelUp'
  | 'gameOver';

/**
 * Master volume. Deliberately low: this plays over whatever the player already
 * has on, and a puzzle game earning its own volume slider would be arrogant.
 */
export const MASTER_GAIN = 0.16;

/** Attack of every envelope. Long enough not to click, short enough to be a blip. */
const ATTACK_MS = 4;

/** Floor of the exponential ramps. `exponentialRampToValueAtTime` rejects zero. */
const SILENCE = 0.0001;

/**
 * Concurrent oscillators allowed. Hammering soft drop on a busy board can queue
 * a lot of blips; past this the newest cue is simply dropped, which is far less
 * noticeable than the mush of twenty overlapping square waves.
 */
export const MAX_VOICES = 16;

/**
 * A line clear's root note, and how far it climbs per extra row.
 *
 * G4, up a minor third for each additional row: a single is a G, a quad lands
 * an octave and a fifth higher. The interval is what makes "that was a big one"
 * legible without looking at the score.
 */
const CLEAR_ROOT_HZ = 392;
const CLEAR_ROW_INTERVAL = 2 ** (3 / 12);

/** Cues with nothing to parameterise are just constant tone lists. */
const CUES: Readonly<Record<Exclude<SoundCue, 'clear'>, readonly ToneSpec[]>> = {
  // A dry tick. This one fires several times a second, so it stays out of the
  // way: short, quiet, and low enough not to compete with the clear chord.
  move: [{ wave: 'square', startHz: 196, endHz: 186, delayMs: 0, durationMs: 32, gain: 0.3 }],
  // A small upward flick, so a rotation is audibly not a move.
  rotate: [{ wave: 'triangle', startHz: 330, endHz: 415, delayMs: 0, durationMs: 52, gain: 0.4 }],
  // Softer and lower than a move: the piece is going down, not sideways.
  softDrop: [{ wave: 'sine', startHz: 165, endHz: 147, delayMs: 0, durationMs: 28, gain: 0.26 }],
  // A whoosh into a thud — the slam is the whole point of a hard drop.
  hardDrop: [
    { wave: 'sawtooth', startHz: 520, endHz: 120, delayMs: 0, durationMs: 100, gain: 0.34 },
    { wave: 'square', startHz: 98, endHz: 62, delayMs: 70, durationMs: 110, gain: 0.42 },
  ],
  // The piece settling. Quiet, because it happens on every single piece.
  lock: [{ wave: 'triangle', startHz: 147, endHz: 110, delayMs: 0, durationMs: 74, gain: 0.34 }],
  // Three notes up a major triad: unmistakably good news.
  levelUp: [
    { wave: 'triangle', startHz: 523, endHz: 523, delayMs: 0, durationMs: 110, gain: 0.4 },
    { wave: 'triangle', startHz: 659, endHz: 659, delayMs: 90, durationMs: 110, gain: 0.4 },
    { wave: 'triangle', startHz: 784, endHz: 880, delayMs: 180, durationMs: 220, gain: 0.44 },
  ],
  // The same shape inverted and slowed down: three notes walking off a cliff.
  gameOver: [
    { wave: 'triangle', startHz: 392, endHz: 392, delayMs: 0, durationMs: 190, gain: 0.42 },
    { wave: 'triangle', startHz: 311, endHz: 311, delayMs: 170, durationMs: 190, gain: 0.42 },
    { wave: 'sawtooth', startHz: 233, endHz: 110, delayMs: 340, durationMs: 520, gain: 0.4 },
  ],
};

/**
 * A line clear, pitched to the number of rows.
 *
 * One row is a two-note figure; every extra row adds a note to the arpeggio and
 * lifts the whole thing by a minor third, so a quad is both higher and fuller
 * than a single without needing a different sound.
 */
function clearTones(rows: number): readonly ToneSpec[] {
  const count = Math.max(1, Math.min(4, Math.floor(rows)));
  const root = CLEAR_ROOT_HZ * CLEAR_ROW_INTERVAL ** (count - 1);
  // Root, major third, fifth, octave — as many as the clear earned, plus one.
  const ratios = [1, 5 / 4, 3 / 2, 2, 5 / 2];
  const tones: ToneSpec[] = [];
  for (let index = 0; index <= count; index += 1) {
    const ratio = ratios[index] ?? 2;
    tones.push({
      wave: 'triangle',
      startHz: root * ratio,
      // The last note lifts a little, so the figure resolves upward.
      endHz: index === count ? root * ratio * 1.06 : root * ratio,
      delayMs: index * 48,
      durationMs: index === count ? 260 : 150,
      gain: 0.38,
    });
  }
  return tones;
}

/** The tones a cue is made of. `rows` only matters for `clear`. */
export function cueTones(cue: SoundCue, rows = 1): readonly ToneSpec[] {
  return cue === 'clear' ? clearTones(rows) : CUES[cue];
}

/** How long a cue rings for, in milliseconds — the tail of its last tone. */
export function cueDurationMs(cue: SoundCue, rows = 1): number {
  let end = 0;
  for (const tone of cueTones(cue, rows)) {
    end = Math.max(end, tone.delayMs + tone.durationMs);
  }
  return end;
}

// ---------------------------------------------------------------------------
// Stored preference
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------

export interface GameAudio {
  /** Play a cue. Silently does nothing while muted or locked. */
  play(cue: SoundCue, rows?: number): void;
  muted(): boolean;
  /** Flip the mute and persist it. Returns the new value. */
  toggleMute(): boolean;
  /**
   * Note a user gesture. The first one builds the `AudioContext`; later ones
   * nudge a context the browser has suspended behind our back.
   */
  unlock(): void;
  /** Has a context been built and started? Used by the HUD copy and by tests. */
  ready(): boolean;
  destroy(): void;
}

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof AudioContext === 'function') {
    return AudioContext;
  }
  // Older WebKit only has the prefixed constructor.
  const legacy: unknown =
    typeof window === 'undefined' ? undefined : Reflect.get(window, 'webkitAudioContext');
  return typeof legacy === 'function' ? (legacy as AudioContextCtor) : null;
}

export interface GameAudioOptions {
  /** Where the unlock listeners go. Defaults to the document. */
  readonly gestureTarget?: EventTarget;
  /**
   * Whether sound is *on*, kept between visits. Phrased as the positive on
   * purpose: the stored settings say what the player wants to hear, and this
   * module is the only one that finds it convenient to think in mutes.
   *
   * Sound is on out of the box. Nothing can make a noise before the player's
   * first tap, so an unmuted default cannot ambush anyone; it just means the
   * game has a voice for the people who never open a settings menu.
   */
  readonly storage?: SettingAccess<boolean>;
}

export function createGameAudio(options: GameAudioOptions = {}): GameAudio {
  const Ctor = audioContextCtor();
  const target = options.gestureTarget ?? (typeof document === 'undefined' ? null : document);

  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let muted = options.storage?.read() === false;
  let voices = 0;
  let listening = false;

  /** Build the context, once, and only ever from inside a gesture. */
  function ensure(): void {
    if (context !== null || Ctor === null) {
      return;
    }
    try {
      context = new Ctor();
      master = context.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(context.destination);
    } catch {
      // No audio on this device. Everything below already tolerates that.
      context = null;
      master = null;
    }
  }

  function running(): boolean {
    return context !== null && context.state === 'running';
  }

  function onGesture(): void {
    ensure();
    if (context === null) {
      stopListening();
      return;
    }
    if (context.state === 'suspended') {
      // A rejected resume is normal — the gesture may not have counted. The
      // listeners stay attached, so the next tap tries again.
      void context.resume().catch(() => {});
    }
    if (context.state === 'running') {
      stopListening();
    }
  }

  function startListening(): void {
    if (listening || target === null) {
      return;
    }
    listening = true;
    for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
      target.addEventListener(type, onGesture, { passive: true });
    }
  }

  function stopListening(): void {
    if (!listening || target === null) {
      return;
    }
    listening = false;
    for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
      target.removeEventListener(type, onGesture);
    }
  }

  /** One oscillator, enveloped, connected and scheduled to clean itself up. */
  function schedule(ctx: AudioContext, out: GainNode, tone: ToneSpec, at: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = at + tone.delayMs / 1000;
    const attack = start + ATTACK_MS / 1000;
    const end = start + tone.durationMs / 1000;

    osc.type = tone.wave;
    osc.frequency.setValueAtTime(tone.startHz, start);
    if (tone.endHz !== tone.startHz) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(tone.endHz, 1), end);
    }

    gain.gain.setValueAtTime(SILENCE, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(tone.gain, SILENCE), attack);
    gain.gain.exponentialRampToValueAtTime(SILENCE, end);

    osc.connect(gain);
    gain.connect(out);

    voices += 1;
    osc.onended = (): void => {
      voices -= 1;
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(start);
    osc.stop(end);
  }

  startListening();

  return {
    play(cue: SoundCue, rows = 1): void {
      if (muted) {
        return;
      }
      if (!running()) {
        // Not unlocked yet, or the browser suspended us. Ask, and stay quiet.
        if (context !== null && context.state === 'suspended') {
          void context.resume().catch(() => {});
        }
        return;
      }
      const ctx = context;
      const out = master;
      if (ctx === null || out === null || voices >= MAX_VOICES) {
        return;
      }
      const at = ctx.currentTime;
      for (const tone of cueTones(cue, rows)) {
        schedule(ctx, out, tone, at);
      }
    },

    muted: () => muted,

    toggleMute(): boolean {
      muted = !muted;
      options.storage?.write(!muted);
      if (!muted) {
        // Unmuting is itself a gesture, so it is a fine moment to wake up.
        onGesture();
      }
      return muted;
    },

    unlock: onGesture,

    ready: running,

    destroy(): void {
      stopListening();
      void context?.close().catch(() => {});
      context = null;
      master = null;
    },
  };
}
