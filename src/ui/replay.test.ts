/**
 * The viewer's machine and its words, without a DOM.
 *
 * Everything the replay bar shows is a pure function of the run and the
 * playback clock, so all of it can be checked here; what is left for
 * `src/main.ts` is moving those strings into elements, which is what that file
 * is for.
 */

import { describe, expect, it } from 'vitest';

import {
  applyInput,
  createGame,
  createRecorder,
  update,
  type GameState,
  type ReplayLog,
} from '../engine';
import {
  REPLAY_SPEEDS,
  createReplayViewer,
  replayCaption,
  replayResult,
  replaySpeedLabel,
  type ReplayRequest,
} from './replay';

/** A short scripted run, recorded, so the tests have a real log to watch. */
function recordRun(seed: number, presses: number): { state: GameState; log: ReplayLog } {
  const recorder = createRecorder();
  let state = createGame({ seed });
  const send = (input: 'resume' | 'moveLeft' | 'rotateCW' | 'hardDrop' | 'hold'): void => {
    recorder.record(state.elapsedMs, input);
    state = applyInput(state, { type: input });
  };
  const wait = (ms: number): void => {
    let left = ms;
    while (left > 0) {
      const frame = Math.min(left, 16);
      state = update(state, frame);
      left -= frame;
      recorder.mark(state.elapsedMs);
    }
  };

  send('resume');
  const script = ['moveLeft', 'rotateCW', 'hardDrop', 'hold'] as const;
  for (let index = 0; index < presses; index += 1) {
    send(script[index % script.length] ?? 'moveLeft');
    wait(120);
  }
  wait(400);
  recorder.mark(state.elapsedMs);
  return { state, log: recorder.log() };
}

function request(seed = 5, presses = 60, origin: 'own' | 'link' = 'own'): ReplayRequest {
  return { seed, startLevel: 1, mode: 'marathon', log: recordRun(seed, presses).log, origin };
}

describe('the speeds', () => {
  it('offers real time and two ways to hurry it along', () => {
    expect(REPLAY_SPEEDS).toEqual([1, 2, 4]);
  });

  it('writes them the one way', () => {
    expect(REPLAY_SPEEDS.map(replaySpeedLabel)).toEqual(['1×', '2×', '4×']);
  });
});

describe('the result, known before a frame is painted', () => {
  it('is the run played to its end', () => {
    const run = recordRun(9, 80);
    const result = replayResult({
      seed: 9,
      startLevel: 1,
      mode: 'marathon',
      log: run.log,
      origin: 'own',
    });
    expect(result.score).toBe(run.state.score);
    expect(result.lines).toBe(run.state.lines);
    expect(result.level).toBe(run.state.level);
    expect(result.durationMs).toBe(run.state.elapsedMs);
  });
});

describe('the caption', () => {
  const view = {
    request: request(5, 40, 'link'),
    result: {
      score: 4200,
      lines: 12,
      level: 3,
      outcome: 'toppedOut' as const,
      durationMs: 65_000,
    },
    clockMs: 20_000,
    durationMs: 65_000,
    playing: true,
    done: false,
  };

  it('says "replay" where nobody could miss it', () => {
    expect(replayCaption(view).badge).toBe('Replay');
  });

  it('says whose run it is', () => {
    expect(replayCaption(view).title).toContain('shared');
    expect(replayCaption({ ...view, request: request(5, 40, 'own') }).title).toContain('your');
  });

  it('quotes the score a shared link promised', () => {
    // The whole point of a shared link is a number somebody is proud of; a
    // viewer that made you sit through two minutes to see it would be a poor
    // way to deliver it.
    expect(replayCaption(view).announcement).toContain('4,200');
  });

  it('names the mode and the run', () => {
    expect(replayCaption(view).detail).toContain('Marathon');
    expect(replayCaption(view).detail).toContain('Game over');
  });

  it('mentions a head start, and stays quiet about level 1', () => {
    const high = { ...view, request: { ...view.request, startLevel: 6 } };
    expect(replayCaption(high).detail).toContain('level 6');
    expect(replayCaption(view).detail).not.toContain('from level');
  });

  it('reads the clock as a clock', () => {
    expect(replayCaption(view).progress).toBe('0:20 / 1:05');
  });

  it('measures how far through it is', () => {
    expect(replayCaption(view).fraction).toBeCloseTo(20 / 65);
    expect(replayCaption({ ...view, clockMs: 0 }).fraction).toBe(0);
    expect(replayCaption({ ...view, clockMs: 65_000 }).fraction).toBe(1);
    // A zero-length run is finished, not divided by zero.
    expect(replayCaption({ ...view, durationMs: 0, clockMs: 0 }).fraction).toBe(1);
  });

  it('changes what the button offers as the replay goes on', () => {
    expect(replayCaption(view).playLabel).toBe('Pause');
    expect(replayCaption({ ...view, playing: false }).playLabel).toBe('Play');
    // A dead button at the end of a replay is a small betrayal.
    expect(replayCaption({ ...view, done: true }).playLabel).toBe('Watch again');
  });

  it('tells the player how to leave', () => {
    expect(replayCaption(view).announcement).toContain('Escape');
  });
});

describe('the viewer', () => {
  it('starts inactive and stays quiet', () => {
    const viewer = createReplayViewer();
    expect(viewer.active()).toBe(false);
    expect(viewer.state()).toBeNull();
    expect(viewer.caption()).toBeNull();
    expect(viewer.events()).toEqual([]);
    // None of these should mind being called with nothing loaded.
    expect(() => {
      viewer.update(16);
      viewer.togglePlay();
      viewer.restart();
      viewer.close();
    }).not.toThrow();
  });

  it('opens playing, at real speed', () => {
    const viewer = createReplayViewer();
    viewer.open(request());
    expect(viewer.active()).toBe(true);
    expect(viewer.playing()).toBe(true);
    expect(viewer.speed()).toBe(1);
    expect(viewer.done()).toBe(false);
  });

  it('reaches the same final state the run ended on', () => {
    const run = recordRun(13, 90);
    const viewer = createReplayViewer();
    viewer.open({ seed: 13, startLevel: 1, mode: 'marathon', log: run.log, origin: 'own' });
    let frames = 0;
    while (!viewer.done() && frames < 100_000) {
      viewer.update(16);
      frames += 1;
    }
    expect(viewer.done()).toBe(true);
    expect(viewer.state()).toEqual(run.state);
  });

  it('stops the clock while paused', () => {
    const viewer = createReplayViewer();
    viewer.open(request());
    viewer.update(500);
    const at = viewer.caption()?.progress;
    viewer.togglePlay();
    expect(viewer.playing()).toBe(false);
    viewer.update(5_000);
    expect(viewer.caption()?.progress).toBe(at);
    viewer.togglePlay();
    viewer.update(500);
    expect(viewer.caption()?.progress).not.toBe(at);
  });

  it('gets through the run four times faster at 4×, and lands in the same place', () => {
    const run = recordRun(21, 70);
    const play = (speed: 1 | 2 | 4): { frames: number; state: GameState | null } => {
      const viewer = createReplayViewer();
      viewer.open({ seed: 21, startLevel: 1, mode: 'marathon', log: run.log, origin: 'own' });
      viewer.setSpeed(speed);
      let frames = 0;
      while (!viewer.done() && frames < 100_000) {
        viewer.update(16);
        frames += 1;
      }
      return { frames, state: viewer.state() };
    };
    const single = play(1);
    const quadruple = play(4);
    expect(quadruple.frames).toBeLessThan(single.frames);
    // Speed changes the pace and nothing else — the run is the same run.
    expect(quadruple.state).toEqual(single.state);
  });

  it('stops playing when it reaches the end', () => {
    const viewer = createReplayViewer();
    viewer.open(request(7, 30));
    viewer.update(10_000_000);
    expect(viewer.done()).toBe(true);
    expect(viewer.playing()).toBe(false);
  });

  it('plays again from the top when the button is pressed at the end', () => {
    const viewer = createReplayViewer();
    viewer.open(request(7, 30));
    viewer.update(10_000_000);
    viewer.togglePlay();
    expect(viewer.done()).toBe(false);
    expect(viewer.playing()).toBe(true);
    expect(viewer.caption()?.progress).toMatch(/^0:00 /);
  });

  it('starts over on demand, playing', () => {
    const viewer = createReplayViewer();
    viewer.open(request());
    viewer.update(2_000);
    viewer.togglePlay();
    viewer.restart();
    expect(viewer.playing()).toBe(true);
    expect(viewer.caption()?.progress).toMatch(/^0:00 /);
  });

  it('keeps the board from before the step, for the effects layer', () => {
    const viewer = createReplayViewer();
    viewer.open(request(31, 80));
    let sawEvents = false;
    for (let frame = 0; frame < 4_000 && !viewer.done(); frame += 1) {
      const before = viewer.previousBoard();
      viewer.update(16);
      if (viewer.events().length > 0) {
        sawEvents = true;
        expect(before).not.toBeNull();
      }
    }
    // A run of eighty presses locks pieces; the burst has to have something to
    // recover the colours of a collapsed row from.
    expect(sawEvents).toBe(true);
  });

  it('forgets everything when it closes', () => {
    const viewer = createReplayViewer();
    viewer.open(request());
    viewer.close();
    expect(viewer.active()).toBe(false);
    expect(viewer.state()).toBeNull();
    expect(viewer.result()).toBeNull();
    expect(viewer.origin()).toBeNull();
  });

  it('opens the next run at real speed, whatever the last one was left at', () => {
    const viewer = createReplayViewer();
    viewer.open(request());
    viewer.setSpeed(4);
    viewer.open(request(6, 20));
    expect(viewer.speed()).toBe(1);
  });

  it('tells the caller when something changed', () => {
    let changes = 0;
    const viewer = createReplayViewer({ onChange: () => (changes += 1) });
    viewer.open(request());
    const afterOpen = changes;
    viewer.setSpeed(2);
    expect(changes).toBeGreaterThan(afterOpen);
    // Setting the speed it is already on is not a change.
    const afterSpeed = changes;
    viewer.setSpeed(2);
    expect(changes).toBe(afterSpeed);
  });
});
