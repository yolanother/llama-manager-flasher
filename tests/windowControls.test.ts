// Llama Manager Flasher — custom window-control behavior tests.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Verifies the narrow command dispatcher used by the frameless Electron
// titlebar. The tests exercise minimize, maximize/restore, and close through
// the same public command interface the main-process IPC handler calls, while
// ensuring unsupported renderer input cannot invoke an arbitrary operation.

import { describe, expect, it, vi } from 'vitest';
import { dispatchWindowControl } from '../src/shared/windowControls';

/** BrowserWindow behavior needed by the custom titlebar command dispatcher. */
interface FakeWindow {
  minimize: ReturnType<typeof vi.fn>;
  maximize: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
}

/**
 * Creates an observable BrowserWindow stand-in for one dispatcher test.
 *
 * @param maximized - Whether the fake begins maximized.
 * @returns A fake exposing only the titlebar's allowed operations.
 */
function fakeWindow(maximized = false): FakeWindow {
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    restore: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(() => maximized),
  };
}

describe('dispatchWindowControl', () => {
  it('dispatches only the requested native window action', () => {
    const target = fakeWindow();

    dispatchWindowControl('minimize', target);

    expect(target.minimize).toHaveBeenCalledOnce();
    expect(target.maximize).not.toHaveBeenCalled();
    expect(target.restore).not.toHaveBeenCalled();
    expect(target.close).not.toHaveBeenCalled();
  });

  it('toggles maximize and restore through one native-equivalent command', () => {
    const restored = fakeWindow(false);
    const maximized = fakeWindow(true);

    dispatchWindowControl('maximize', restored);
    dispatchWindowControl('maximize', maximized);

    expect(restored.maximize).toHaveBeenCalledOnce();
    expect(restored.restore).not.toHaveBeenCalled();
    expect(maximized.restore).toHaveBeenCalledOnce();
    expect(maximized.maximize).not.toHaveBeenCalled();
  });

  it('closes the originating window and rejects commands outside the allow list', () => {
    const target = fakeWindow();

    dispatchWindowControl('close', target);

    expect(target.close).toHaveBeenCalledOnce();
    expect(() => dispatchWindowControl('open-devtools' as never, target)).toThrow(
      /unsupported window control/,
    );
  });
});
