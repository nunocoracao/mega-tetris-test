/**
 * @vitest-environment jsdom
 *
 * The automated accessibility audit, plus the keyboard behaviour a static audit
 * cannot see.
 *
 * This is the only file in the project that wants a DOM, so it asks for one
 * rather than making the whole suite pay for jsdom: everything else still runs
 * in `node`, which is what keeps `src/engine/` honest. `npm run a11y` runs just
 * this file; `npm test` runs it along with everything else.
 *
 * axe-core is given the *real* shell — the same `createShell` the game boots —
 * inside the same document skeleton `index.html` provides, and is run three
 * times: with the dialogs closed, with the pause menu open, and with the help
 * panel open. A rule that only bites while a modal is up would otherwise never
 * be checked.
 *
 * What axe cannot check here is colour contrast: it works by asking a rendering
 * engine what pixels it painted, and jsdom paints nothing. That half of the job
 * is done, exhaustively, in `style.test.ts` against the palette itself.
 */

import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BOT_DIFFICULTIES, GAME_MODES } from '../engine';
import { cellLabel, defaultDaily, historyCells } from './daily';
import { createModal, focusableWithin, type Modal } from './dialog';
import {
  ACTION_IDS,
  HANDLING_BOUNDS,
  createKeyboardInput,
  createLiveBindings,
  describeBinding,
  type ActionId,
  type LiveBindings,
} from './input';
import { REPLAY_SPEEDS } from './replay';
import { createSettingsPanel, type SettingsPanel } from './settings';
import { applyBindings, createShell, type Shell } from './shell';
import { DEFAULT_THEME, THEME_IDS, themeLabel } from './theme';

let root: HTMLElement;
let shell: Shell;

beforeEach(() => {
  // What `index.html` provides around the mount point.
  document.documentElement.lang = 'en';
  document.title = 'Mega Tetris — a cheerful falling-block arcade';
  document.body.innerHTML = '<div id="app"></div>';
  root = document.querySelector<HTMLElement>('#app') as HTMLElement;
  shell = createShell(root);
});

afterEach(() => {
  document.body.innerHTML = '';
});

/** Every violation as one readable block, so a failure says what to fix. */
function report(violations: readonly axe.Result[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `    ${node.html}`).join('\n'),
    )
    .join('\n');
}

async function audit(): Promise<axe.Result[]> {
  const results = await axe.run(document, {
    // Contrast needs real layout, which jsdom does not do; `style.test.ts`
    // covers it against the palette instead. Everything else runs.
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  return results.violations;
}

/**
 * The daily block as `src/main.ts` leaves it — two lines of copy, thirty
 * labelled cells and a visible copy button. Auditing it empty would audit
 * nothing, since every string on it is written at runtime.
 */
function fillDailyBlock(): void {
  shell.daily.hidden = false;
  shell.dailyStatus.textContent = '23 August 2026 — today’s run is waiting.';
  shell.dailyStreak.textContent = 'Streak: 4 days (longest 9 days).';
  shell.dailyCopy.hidden = false;
  shell.dailyFallback.hidden = false;
  shell.dailyShare.value = 'Mega Tetris — Daily 2026-08-23';
  const cells = historyCells(defaultDaily(), '2026-08-23');
  for (const [index, cell] of cells.entries()) {
    const node = shell.dailyCells[index];
    const text = node?.querySelector<HTMLElement>('[data-daily-cell-text]');
    if (node !== undefined && text !== null && text !== undefined) {
      node.title = cellLabel(cell);
      text.textContent = cellLabel(cell);
    }
  }
}

describe('the page axe sees', () => {
  it('has no violations with the dialogs closed', async () => {
    const violations = await audit();

    expect(report(violations)).toBe('');
  });

  it('has no violations with the start screen showing', async () => {
    // The overlay is hidden in the shell as built, so its pickers would never
    // be audited otherwise — and the mode picker is the newest thing on it.
    shell.overlay.hidden = false;
    shell.overlayStart.hidden = false;
    shell.overlayHelp.hidden = false;
    fillDailyBlock();

    const violations = await audit();

    expect(report(violations)).toBe('');
  });

  it('has no violations with a replay playing', async () => {
    // The replay bar, the badge and the run-summary panel's two extra buttons,
    // all as `src/main.ts` leaves them while a replay is on the well.
    document.documentElement.dataset['replay'] = 'on';
    shell.replayBar.hidden = false;
    shell.replayBadge.hidden = false;
    shell.replayTitle.textContent = 'Watching a shared run';
    shell.replayDetail.textContent = 'Marathon — Game over';
    shell.replayProgress.textContent = '0:20 / 1:05';
    shell.overlay.hidden = false;
    shell.overlayActions.hidden = false;
    shell.shareFallback.hidden = false;
    shell.shareText.value = 'https://example.test/#r=abc';

    const violations = await audit();

    expect(report(violations)).toBe('');
  });

  it('has no violations with the pause menu open', async () => {
    shell.pauseDialog.hidden = false;
    for (const node of shell.background) {
      node.setAttribute('inert', '');
    }

    const violations = await audit();

    expect(report(violations)).toBe('');
  });

  it('has no violations with the help panel open', async () => {
    shell.helpDialog.hidden = false;
    for (const node of shell.background) {
      node.setAttribute('inert', '');
    }

    const violations = await audit();

    expect(report(violations)).toBe('');
  });
});

/**
 * The settings dialog.
 *
 * Audited in all three of its states — closed, open, and waiting for a key —
 * because the third one is a *mode*, and a mode nothing on the page announces
 * is a mode that does not exist for a good many players.
 */
describe('the settings dialog', () => {
  let bindings: LiveBindings;
  let modal: Modal;
  let panel: SettingsPanel;
  let announced: string[];

  /** The panel wired to plain in-memory settings — no store, no audio, no CSS. */
  function build(): void {
    announced = [];
    bindings = createLiveBindings();
    let sound = true;
    let motion = 'auto';
    let contrast = 'auto';
    let theme = 'midnight';
    let pad = 'auto';
    modal = createModal({
      element: shell.settingsDialog,
      background: [...shell.background, shell.pauseDialog, shell.helpDialog],
      initialFocus: () => shell.settings.panel,
      onOpen: () => panel.reset(),
      onClose: () => panel.cancelCapture(),
    });
    panel = createSettingsPanel({
      elements: shell.settings,
      bindings,
      sound: { read: () => sound, write: (value) => (sound = value) },
      motion: {
        read: () => motion as never,
        write: (value) => (motion = value),
      },
      contrast: {
        read: () => contrast as never,
        write: (value) => (contrast = value),
      },
      theme: {
        read: () => theme as never,
        write: (value) => (theme = value),
      },
      pad: { read: () => pad as never, write: (value) => (pad = value) },
      announce: (message) => announced.push(message),
      refresh: () => modal.refresh(),
      resetAll: () => bindings.setKeyMap(createLiveBindings().table().map),
    });
    bindings.listen(() => applyBindings(shell, bindings.table()));
    applyBindings(shell, bindings.table());
  }

  /** The "Add key" button of one row. */
  function bindButton(action: ActionId): HTMLButtonElement {
    const button = shell.settings.keymap.querySelector<HTMLButtonElement>(
      `[data-key-bind="${action}"]`,
    );
    expect(button, `no bind button for ${action}`).not.toBeNull();
    return button as HTMLButtonElement;
  }

  function press(key: string, init: KeyboardEventInit = {}): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  }

  beforeEach(build);
  afterEach(() => {
    panel.destroy();
    modal.destroy();
  });

  it('has no violations while it is open', async () => {
    modal.open();

    expect(report(await audit())).toBe('');
  });

  it('has no violations while it is waiting for a key', async () => {
    modal.open();
    bindButton('hardDrop').click();

    expect(panel.capturing()).toBe('hardDrop');
    expect(report(await audit())).toBe('');
  });

  it('is a real modal dialog with a title', () => {
    const dialogPanel = shell.settingsDialog.querySelector('[role="dialog"]');

    expect(dialogPanel?.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialogPanel?.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(labelledBy)?.textContent?.trim()).toBe('Settings');
  });

  it('adds no second live region', () => {
    modal.open();

    expect(root.querySelectorAll('[aria-live]')).toHaveLength(1);
    // The panel's explanation line is plain text; every sentence it shows also
    // goes through the game's one polite region.
    expect(shell.settings.message.hasAttribute('aria-live')).toBe(false);
  });

  it('traps focus and gives it back to whatever opened it', () => {
    shell.settingsButton.focus();

    modal.open();
    expect(shell.settingsDialog.contains(document.activeElement)).toBe(true);

    modal.close();
    expect(document.activeElement).toBe(shell.settingsButton);
  });

  it('closes on Escape, even in the middle of a capture', () => {
    modal.open();
    bindButton('hold').click();
    expect(panel.capturing()).toBe('hold');

    shell.settings.panel.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    expect(modal.isOpen()).toBe(false);
    expect(panel.capturing()).toBeNull();
  });

  it('gives every action a row, with its own named buttons', () => {
    const rows = [...shell.settings.keymap.querySelectorAll('li')];

    expect(rows).toHaveLength(ACTION_IDS.length);
    for (const action of ACTION_IDS) {
      const name = bindButton(action).getAttribute('aria-label') ?? '';
      expect(name, `${action} has an unhelpful button name`).toMatch(/Add a key for /);
      const reset = shell.settings.keymap.querySelector(`[data-key-reset="${action}"]`);
      expect(reset?.getAttribute('aria-label')).toMatch(/^Reset /);
    }
  });

  it('offers a way to take each key off, named after the key and the action', () => {
    const clear = shell.settings.keymap.querySelector('[data-key-clear]');

    expect(clear?.tagName).toBe('BUTTON');
    expect(clear?.getAttribute('aria-label')).toBe('Clear ← from Move left');
  });

  it('captures a key, binds it, and says what it did', () => {
    modal.open();
    bindButton('hardDrop').click();

    press('q');

    expect(panel.capturing()).toBeNull();
    expect(bindings.table().keys('hardDrop')).toEqual([' ', 'Q']);
    expect(announced.at(-1)).toBe('Q is now Hard drop.');
  });

  it('refuses a key another action owns, in words rather than a colour', () => {
    modal.open();
    bindButton('hold').click();

    press(' ');

    // Still capturing: the player can simply press something else.
    expect(panel.capturing()).toBe('hold');
    expect(bindings.table().keys('hold')).toEqual(['C', 'Shift']);
    const message = shell.settings.message.textContent ?? '';
    expect(message).toContain('Space');
    expect(message).toContain('Hard drop');
    expect(announced.at(-1)).toBe(message);
  });

  it('refuses Tab and lets it go on moving focus', () => {
    modal.open();
    bindButton('hold').click();

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);

    expect(panel.capturing()).toBeNull();
    expect(shell.settings.message.textContent).toMatch(/Tab/);
  });

  it('refuses a key held with a modifier and keeps waiting', () => {
    modal.open();
    bindButton('hold').click();

    press('q', { ctrlKey: true });

    expect(panel.capturing()).toBe('hold');
    expect(bindings.table().keys('hold')).toEqual(['C', 'Shift']);
    expect(shell.settings.message.textContent).toMatch(/one key on its own/);
  });

  it('will not let the last pause key go', () => {
    bindings.setKeyMap({ ...bindings.table().map, togglePause: ['P'] });
    modal.open();

    shell.settings.keymap
      .querySelector<HTMLButtonElement>('[data-key-clear-action="togglePause"]')
      ?.click();

    expect(bindings.table().keys('togglePause')).toEqual(['P']);
    expect(shell.settings.message.textContent).toMatch(/at least one key/);
  });

  it('moves the help panel and the pad with the binding', () => {
    // The no-drift property, end to end: one table, three views of it, and no
    // module holding a copy of the key list.
    modal.open();
    bindButton('hardDrop').click();
    press('q');

    const binding = bindings.table().list.find((candidate) => candidate.action === 'hardDrop');
    expect(binding && describeBinding(binding)).toBe('Space / Q');

    const helpTerms = [...shell.helpBody.querySelectorAll('.help__keys')].map((node) =>
      node.textContent?.trim(),
    );
    expect(helpTerms).toContain('Space / Q');

    const controlTerms = [...shell.controlsList.querySelectorAll('.controls__keys')].map((node) =>
      node.textContent?.trim(),
    );
    expect(controlTerms).toContain('Space / Q');

    const padButton = shell.padButtons.find(
      (button) => button.dataset['padAction'] === 'hardDrop',
    );
    expect(padButton?.title).toBe('Hard drop — Space / Q');
  });

  it('offers the handling as bounded, labelled, stepped sliders', () => {
    for (const bound of HANDLING_BOUNDS) {
      const input = shell.settings.handlingInputs.find(
        (candidate) => candidate.dataset['handling'] === bound.key,
      );
      expect(input, bound.key).toBeDefined();
      expect(input?.type).toBe('range');
      expect(input?.min).toBe(String(bound.min));
      expect(input?.max).toBe(String(bound.max));
      expect(input?.step).toBe(String(bound.step));
      // A label, and an explanation the label does not have room for.
      const label = document.querySelector(`label[for="${input?.id ?? ''}"]`);
      expect(label?.textContent?.trim()).toBe(bound.label);
      const hint = document.getElementById(input?.getAttribute('aria-describedby') ?? '');
      expect(hint?.textContent?.trim()).toBe(bound.hint);
    }
  });

  it('takes a slider change straight into the live handling, with its units shown', () => {
    modal.open();
    const das = shell.settings.handlingInputs[0] as HTMLInputElement;

    das.value = '60';
    das.dispatchEvent(new Event('change', { bubbles: true }));

    expect(bindings.handling().dasMs).toBe(60);
    expect(shell.settings.handlingValues[0]?.textContent).toBe('60 ms');
  });

  it('groups the cabinet preferences as radios that say which is chosen', () => {
    modal.open();

    for (const inputs of [
      shell.settings.motionInputs,
      shell.settings.contrastInputs,
      shell.settings.padInputs,
    ]) {
      expect(inputs.length).toBe(3);
      expect(inputs.filter((input) => input.checked)).toHaveLength(1);
      const legend = inputs[0]?.closest('fieldset')?.querySelector('legend');
      expect(legend?.textContent?.trim()).not.toBe('');
    }
  });

  it('offers every skin as a named, checkable radio in one group', () => {
    // A swatch is a picture of a colour scheme, and a picture is nothing to a
    // screen reader — so the *name* is the control's label and the swatch is
    // decoration beside it. Radios rather than a cycling button, for the same
    // reason the other three preferences are: the group announces which skin is
    // chosen without anybody having to press anything to find out, and arrow
    // keys move between them for free.
    modal.open();

    const inputs = shell.settings.themeInputs;
    expect(inputs.length).toBe(THEME_IDS.length);
    expect(inputs.map((input) => input.value)).toEqual([...THEME_IDS]);
    expect(inputs.filter((input) => input.checked)).toHaveLength(1);
    expect(inputs.find((input) => input.checked)?.value).toBe(DEFAULT_THEME);

    const legend = inputs[0]?.closest('fieldset')?.querySelector('legend');
    expect(legend?.textContent?.trim()).toBe('Cabinet skin');

    for (const input of inputs) {
      const label = input.closest('label');
      const name = label?.querySelector('.choice__name');
      expect(name?.textContent?.trim()).toBe(themeLabel(input.value as never));
      // Nothing here is a tab stop of its own, and nothing here is announced:
      // the swatch is the label's picture, not a second control.
      const swatch = label?.querySelector('.swatch');
      expect(swatch?.getAttribute('aria-hidden')).toBe('true');
      expect(swatch?.getAttribute('data-theme')).toBe(input.value);
    }
  });

  it('takes a skin straight through to the setting, from the keyboard', () => {
    modal.open();

    const lagoon = shell.settings.themeInputs.find((input) => input.value === 'lagoon');
    expect(lagoon).toBeDefined();
    // What an arrow key inside a radio group amounts to: checked, then changed.
    (lagoon as HTMLInputElement).checked = true;
    (lagoon as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));

    expect(shell.settings.themeInputs.filter((input) => input.checked)).toHaveLength(1);
    expect((lagoon as HTMLInputElement).checked).toBe(true);
  });

  it('asks before it throws every setting away', () => {
    modal.open();

    expect(shell.settings.resetConfirm.hidden).toBe(true);
    shell.settings.resetAsk.click();
    expect(shell.settings.resetConfirm.hidden).toBe(false);
    // The safe answer is the one a stray Enter picks.
    expect(document.activeElement).toBe(shell.settings.resetNo);
  });
});

describe('the replay bar', () => {
  beforeEach(() => {
    shell.replayBar.hidden = false;
    shell.replayBadge.hidden = false;
  });

  it('is a labelled region rather than content adrift outside a landmark', () => {
    expect(shell.replayBar.tagName).toBe('SECTION');
    expect(shell.replayBar.getAttribute('aria-label')).not.toBe('');
    expect(shell.replayBar.getAttribute('aria-label')).not.toBeNull();
  });

  it('is under the well, not over it', () => {
    // The one layout rule a replay has: watching a run is entirely about
    // watching the field, so nothing may cover it.
    expect(shell.replayBar.closest('.playfield')).toBeNull();
  });

  it('is every one of it a real button with a name', () => {
    const buttons = [
      shell.replayPlay,
      shell.replayRestart,
      shell.replayExit,
      ...shell.replaySpeeds,
    ];
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.type).toBe('button');
      expect((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()).not.toBe('');
    }
  });

  it('says which speed is chosen rather than only colouring it in', () => {
    const pressed = shell.replaySpeeds.filter(
      (button) => button.getAttribute('aria-pressed') === 'true',
    );
    expect(pressed).toHaveLength(1);
    for (const button of shell.replaySpeeds) {
      expect(['true', 'false']).toContain(button.getAttribute('aria-pressed'));
    }
    expect(shell.replaySpeeds).toHaveLength(REPLAY_SPEEDS.length);
  });

  it('groups the speeds under a name of their own', () => {
    const group = shell.replayBar.querySelector('[role="group"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-label')).toBe('Playback speed');
  });

  it('joins the tab order as soon as it is showing', () => {
    for (const button of [shell.replayPlay, shell.replayExit, ...shell.replaySpeeds]) {
      expect(focusableWithin(document.body)).toContain(button);
    }
  });

  it('keeps the badge out of the accessibility tree, because the bar says it', () => {
    // Two announcements of the word "Replay" would be one too many; the visible
    // stamp is for eyes, the bar is for everybody.
    expect(shell.replayBadge.getAttribute('aria-hidden')).toBe('true');
    expect(shell.replayBar.textContent).toContain('Replay');
  });

  it('goes inert with everything else when a dialog opens', () => {
    expect(shell.background).toContain(shell.replayBar);
  });
});

describe('sharing a run', () => {
  it('labels the fallback box and leaves it read-only', () => {
    shell.shareFallback.hidden = false;
    const label = document.querySelector(`label[for="${shell.shareText.id}"]`);
    expect(label).not.toBeNull();
    expect(shell.shareText.id).not.toBe('');
    expect(shell.shareText.readOnly).toBe(true);
  });

  it('offers watching and sharing as real buttons with names', () => {
    for (const button of [shell.overlayReplay, shell.overlayShare]) {
      expect(button.tagName).toBe('BUTTON');
      expect((button.textContent ?? '').trim()).not.toBe('');
    }
  });
});

describe('structure', () => {
  it('has exactly one h1, and it names the game', () => {
    const h1s = root.querySelectorAll('h1');

    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Mega Tetris');
  });

  it('never skips a heading level', () => {
    const levels = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((node) =>
      Number(node.tagName.slice(1)),
    );

    let previous = 0;
    for (const level of levels) {
      expect(level, `heading jumped from h${previous} to h${level}`).toBeLessThanOrEqual(
        previous + 1,
      );
      previous = level;
    }
  });

  it('puts the game in landmarks', () => {
    expect(root.querySelectorAll('header')).toHaveLength(1);
    expect(root.querySelectorAll('main')).toHaveLength(1);
    expect(root.querySelectorAll('footer')).toHaveLength(1);
  });

  it('gives every button an accessible name', () => {
    const buttons = [...root.querySelectorAll('button')];

    expect(buttons.length).toBeGreaterThan(10);
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';
      expect(name, `${button.outerHTML} has no accessible name`).not.toBe('');
    }
  });

  it('uses real buttons, not clickable divs', () => {
    for (const node of root.querySelectorAll('[data-pad-action], [role="button"]')) {
      expect(node.tagName).toBe('BUTTON');
    }
  });

  it('gives the playfield canvas a text alternative rather than an opaque box', () => {
    expect(shell.boardCanvas.getAttribute('role')).toBe('img');
    const labelledBy = shell.boardCanvas.getAttribute('aria-labelledby');
    expect(labelledBy).toBe(shell.boardSummary.id);
    expect(shell.boardSummary.id).not.toBe('');
  });

  it('has one polite live region and no assertive ones', () => {
    expect(shell.status.getAttribute('aria-live')).toBe('polite');
    expect(root.querySelectorAll('[aria-live="assertive"]')).toHaveLength(0);
    expect(root.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('marks all three dialogs as modal dialogs', () => {
    for (const dialog of [shell.pauseDialog, shell.helpDialog, shell.settingsDialog]) {
      const panel = dialog.querySelector('[role="dialog"]');
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute('aria-modal')).toBe('true');
      const labelledBy = panel?.getAttribute('aria-labelledby') ?? '';
      expect(document.getElementById(labelledBy)?.textContent?.trim()).toBeTruthy();
    }
  });

  it('lists the keyboard controls in the help panel from the binding table', () => {
    // Belt to `help.test.ts`'s braces: the markup that actually shipped into
    // the shell, not just the generator, carries every binding.
    const terms = [...shell.helpDialog.querySelectorAll('.help__keys')].map((node) =>
      node.textContent?.trim(),
    );

    expect(terms).toContain('← / A');
    expect(terms).toContain('? / H');
  });
});

describe('the mode picker', () => {
  function showStartScreen(): void {
    shell.overlay.hidden = false;
    shell.overlayStart.hidden = false;
  }

  it('is one real button per mode, in a labelled group', () => {
    expect(shell.modeButtons).toHaveLength(GAME_MODES.length);
    for (const button of shell.modeButtons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.textContent?.trim()).not.toBe('');
      expect(button.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Game mode');
    }
  });

  it('says which one is chosen rather than only colouring it in', () => {
    for (const button of shell.modeButtons) {
      expect(button.getAttribute('aria-pressed')).toBe('false');
    }
    // `main.ts` publishes the stored answer into these before the first paint;
    // what matters here is that there is somewhere for it to go.
    expect(shell.modeButtons.every((button) => button.hasAttribute('aria-pressed'))).toBe(true);
  });

  it('joins the tab order as soon as the start screen is showing', () => {
    showStartScreen();

    const order = focusableWithin(root)
      .filter((node) => node.closest('.modal') === null)
      .map((node) => node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '');

    for (const button of shell.modeButtons) {
      expect(order).toContain(button.textContent?.trim());
    }
  });

  it('takes focus like any other button, with nothing done to stop it', () => {
    showStartScreen();
    const first = shell.modeButtons[0] as HTMLButtonElement;

    first.focus();

    expect(document.activeElement).toBe(first);
    expect(first.hasAttribute('tabindex')).toBe(false);
    expect(first.hasAttribute('disabled')).toBe(false);
  });

  it('activates on a plain click, which is what Enter and Space produce', () => {
    let clicks = 0;
    const first = shell.modeButtons[0] as HTMLButtonElement;
    first.addEventListener('click', () => {
      clicks += 1;
    });

    first.click();

    expect(clicks).toBe(1);
  });
});

/**
 * Versus, in all three of its states.
 *
 * The rule the whole mode has to survive: a second well is *decoration*. The
 * player cannot act on it, so nothing in it is focusable, nothing in it is a
 * second live region, and what it says is one short sentence rather than a
 * commentary. The meter beside the player's well is the same bargain — it says
 * everything three ways for eyes and once, in words, for everybody else.
 */
describe('a match on the screen', () => {
  /** The shell as `src/main.ts` leaves it once a match is dealt. */
  function showMatch(): void {
    document.documentElement.dataset['versus'] = 'on';
    shell.opponent.hidden = false;
    shell.opponentTag.textContent = 'Quick';
    shell.opponentSummary.textContent = 'Quick opponent. Sent 4 rows. Taking 2.';
    shell.garbage.hidden = false;
    shell.garbage.dataset['level'] = 'imminent';
    shell.garbageCount.textContent = '3';
    shell.garbageLabel.textContent = '3 rows incoming, 3 landing now.';
    for (const [index, cell] of shell.garbageSegments.entries()) {
      cell.dataset['state'] = index < 3 ? 'imminent' : 'empty';
    }
  }

  function showStartScreen(): void {
    shell.overlay.hidden = false;
    shell.overlayStart.hidden = false;
    shell.overlayOpponent.hidden = false;
    shell.overlayHelp.hidden = false;
  }

  function showResult(): void {
    shell.overlay.hidden = false;
    shell.overlayRows.hidden = false;
    shell.overlayVersus.hidden = false;
    shell.overlayVersus.textContent = 'Garbage sent — you 24 rows, Relentless 17 rows.';
    shell.overlayNote.hidden = false;
    shell.overlayNote.textContent = 'Relentless: 1 win, 0 losses.';
  }

  afterEach(() => {
    delete document.documentElement.dataset['versus'];
  });

  it('has no violations with both wells on screen', async () => {
    showMatch();

    expect(report(await audit())).toBe('');
  });

  it('has no violations with the start screen and the opponent picker up', async () => {
    showMatch();
    showStartScreen();
    fillDailyBlock();

    expect(report(await audit())).toBe('');
  });

  it('has no violations on the result screen', async () => {
    showMatch();
    showResult();

    expect(report(await audit())).toBe('');
  });

  it('adds no second live region in any of those states', () => {
    showMatch();
    showStartScreen();
    showResult();

    expect(root.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(root.querySelectorAll('[aria-live="assertive"]')).toHaveLength(0);
    expect(shell.opponentSummary.hasAttribute('aria-live')).toBe(false);
    expect(shell.garbageLabel.hasAttribute('aria-live')).toBe(false);
  });

  it('gives the opponent’s canvas a text alternative rather than an opaque box', () => {
    expect(shell.opponentCanvas.getAttribute('role')).toBe('img');
    expect(shell.opponentCanvas.getAttribute('aria-labelledby')).toBe(shell.opponentSummary.id);
    expect(shell.opponentSummary.id).not.toBe('');
  });

  it('puts nothing focusable in the opponent’s well or the meter', () => {
    showMatch();

    for (const node of [shell.opponent, shell.garbage]) {
      expect(focusableWithin(node)).toEqual([]);
    }
    // The tab order is exactly what it was before there was a second well.
    const order = focusableWithin(root)
      .filter((node) => node.closest('.modal') === null)
      .map((node) => node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '');
    expect(order).toEqual(['Playfield', 'Play', 'Restart', 'Help', 'Settings']);
  });

  it('shows the meter beside the well and never over either of them', () => {
    // The one layout rule a match has. A warning that covers the field is a
    // warning a player cannot act on.
    expect(shell.garbage.closest('.playfield')).toBeNull();
    expect(shell.opponent.closest('.playfield')).toBeNull();
    expect(shell.garbage.contains(shell.playfield)).toBe(false);
    expect(shell.opponent.contains(shell.playfield)).toBe(false);
  });

  it('keeps the meter’s picture out of the accessibility tree and its words in', () => {
    // Three ways of saying one thing for eyes; exactly one for everybody else.
    const stack = shell.garbageSegments[0]?.closest('ol');
    expect(stack?.getAttribute('aria-hidden')).toBe('true');
    expect(shell.garbageCount.getAttribute('aria-hidden')).toBe('true');
    expect(shell.garbageLabel.classList.contains('visually-hidden')).toBe(true);
  });

  it('offers every opponent as a real, named, pressed-or-not button', () => {
    showStartScreen();

    expect(shell.opponentButtons).toHaveLength(BOT_DIFFICULTIES.length);
    for (const button of shell.opponentButtons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(['true', 'false']).toContain(button.getAttribute('aria-pressed'));
      expect(button.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Opponent');
      // The name, and then a sentence saying what actually changes — both part
      // of the button's own accessible name.
      const name = button.textContent?.trim() ?? '';
      expect(name).not.toBe('');
      expect(name).toMatch(/Thinks for \d+ ms/);
    }
  });

  it('joins the tab order with the rest of the start screen', () => {
    showStartScreen();

    const order = focusableWithin(root).filter((node) => node.closest('.modal') === null);
    for (const button of shell.opponentButtons) {
      expect(order).toContain(button);
    }
  });
});

describe('the daily challenge block', () => {
  it('is a list of thirty cells, each with a date and a result in words', () => {
    fillDailyBlock();

    const cells = [...shell.daily.querySelectorAll('li')];
    expect(cells).toHaveLength(30);
    for (const cell of cells) {
      // Two descriptions, neither of them a colour: the tooltip a mouse gets,
      // and the sentence a screen reader reads. The tint on the cell is a
      // fourth-order hint at best, and for some players no hint at all.
      expect(cell.getAttribute('title')).toMatch(/\d{4}/);
      expect(cell.textContent?.trim()).toMatch(/\d{4}/);
    }
  });

  it('names the strip itself, so thirty cells are not thirty orphans', () => {
    const strip = shell.daily.querySelector('ol');

    expect(strip?.getAttribute('aria-label')).toBe('Your last 30 days');
  });

  it('joins the tab order with real buttons when the start screen is up', () => {
    shell.overlay.hidden = false;
    shell.overlayStart.hidden = false;
    fillDailyBlock();

    const order = focusableWithin(root).filter((node) => node.closest('.modal') === null);

    expect(order).toContain(shell.dailyPlay);
    expect(order).toContain(shell.dailyCopy);
    expect(shell.dailyPlay.tagName).toBe('BUTTON');
    expect(shell.dailyCopy.tagName).toBe('BUTTON');
  });

  it('labels the clipboard fallback field', () => {
    const label = shell.daily.querySelector(`label[for="${shell.dailyShare.id}"]`);

    expect(shell.dailyShare.id).not.toBe('');
    expect(label?.textContent?.trim()).not.toBe('');
    expect(shell.dailyShare.readOnly).toBe(true);
  });
});

describe('tab order', () => {
  it('runs top to bottom: readouts, the well, then the actions', () => {
    const order = focusableWithin(root)
      .filter((node) => node.closest('.modal') === null)
      .map((node) => node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '');

    // The pad and the overlay start hidden, so this is the shell's own order.
    // In a browser the overlay's Play button joins it after the first paint,
    // between the playfield and the footer — which is still top to bottom.
    expect(order).toEqual(['Playfield', 'Play', 'Restart', 'Help', 'Settings']);
  });

  it('has no positive tabindex anywhere — the DOM order is the order', () => {
    for (const node of root.querySelectorAll('[tabindex]')) {
      expect(Number(node.getAttribute('tabindex'))).toBeLessThanOrEqual(0);
    }
  });
});

describe('modal behaviour', () => {
  function open(): ReturnType<typeof createModal> {
    return createModal({
      element: shell.pauseDialog,
      background: shell.background,
      initialFocus: () => shell.pauseResume,
    });
  }

  it('moves focus in and puts it back on the trigger', () => {
    shell.playButton.focus();
    const modal = open();

    modal.open();
    expect(document.activeElement).toBe(shell.pauseResume);

    modal.close();
    expect(document.activeElement).toBe(shell.playButton);
  });

  it('makes the game behind it inert while it is up', () => {
    const modal = open();

    modal.open();
    for (const node of shell.background) {
      expect(node.hasAttribute('inert')).toBe(true);
    }

    modal.close();
    for (const node of shell.background) {
      expect(node.hasAttribute('inert')).toBe(false);
    }
  });

  it('closes on Escape from anywhere inside', () => {
    const modal = open();
    modal.open();

    shell.pauseRestart.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    expect(modal.isOpen()).toBe(false);
  });

  it('stops Escape reaching the game underneath', () => {
    let sawEscape = false;
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        sawEscape = true;
      }
    });
    const modal = open();
    modal.open();

    shell.pauseRestart.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    expect(sawEscape).toBe(false);
  });

  it('wraps Tab at both ends rather than letting focus escape', () => {
    const modal = open();
    modal.open();

    const items = focusableWithin(shell.pauseDialog);
    const first = items[0];
    const last = items[items.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();

    last?.focus();
    last?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(last);
  });

  it('hands every key inside it to the dialog, not to the game', () => {
    // Arrow keys scroll a long help panel; space presses the button under the
    // cursor. If the game layer claimed them, neither would work.
    const seen: ActionId[] = [];
    const input = createKeyboardInput({ onAction: (action) => seen.push(action) });
    const modal = open();
    modal.open();

    for (const key of ['ArrowDown', 'ArrowLeft', ' ', 'R']) {
      shell.pauseDialog
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }

    expect(seen).toEqual([]);
    input.destroy();
  });

  it('leaves the live region reachable, so announcements still land', () => {
    const modal = open();
    modal.open();

    expect(shell.status.closest('[inert]')).toBeNull();
  });
});

/**
 * The keyboard, on the player's own keys.
 *
 * `createKeyboardInput` is handed the table rather than reaching for one, and
 * it re-reads it on every press — so a rebind lands on the very next keystroke
 * and there is no listener to tear down and rebuild.
 */
describe('the keyboard under custom bindings', () => {
  it('obeys the table it was handed, and follows it when it changes', () => {
    const bindings = createLiveBindings();
    const seen: ActionId[] = [];
    const input = createKeyboardInput({
      onAction: (action) => seen.push(action),
      bindings: () => bindings.table(),
      target: window,
    });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    expect(seen).toEqual(['hardDrop']);

    bindings.setKeyMap({ ...bindings.table().map, hardDrop: ['Q'] });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }));

    expect(seen).toEqual(['hardDrop', 'hardDrop']);
    input.destroy();
  });
});

/**
 * The two affordances the installable cabinet added.
 *
 * Both are ordinary page content on purpose. The update notice is the one worth
 * spelling out: it would have been easy to make it a toast over the well and a
 * second live region, and both would have been wrong — a player mid-run has to
 * be able to look at it, decide it can wait, and carry on.
 */
describe('the install offer and the update notice', () => {
  it('starts with both put away', () => {
    expect(shell.installButton.hidden).toBe(true);
    expect(shell.updateBar.hidden).toBe(true);
  });

  it('puts the install button among the other footer actions', () => {
    expect(shell.installButton.closest('footer')).toBe(root.querySelector('footer'));
  });

  it('offers the update as real buttons that take focus', () => {
    shell.updateBar.hidden = false;

    for (const button of [shell.updateReload, shell.updateDismiss]) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.textContent?.trim()).not.toBe('');
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('adds no second live region', () => {
    // The game has one polite region and a high bar for what reaches it; the
    // update announcement goes through that one like everything else.
    shell.updateBar.hidden = false;

    expect(shell.updateBar.getAttribute('aria-live')).toBeNull();
    expect(root.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('sits outside the playfield rather than over it', () => {
    expect(shell.playfield.contains(shell.updateBar)).toBe(false);
    expect(shell.updateBar.contains(shell.playfield)).toBe(false);
    // And after the footer, so tabbing to it never means passing back through
    // the game.
    expect(
      shell.updateBar.compareDocumentPosition(shell.playfield) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it('goes inert with everything else while a dialog is open', () => {
    expect(shell.background).toContain(shell.updateBar);
  });

  it('has no violations with both showing', async () => {
    shell.installButton.hidden = false;
    shell.updateBar.hidden = false;

    expect(report(await audit())).toBe('');
  });
});
