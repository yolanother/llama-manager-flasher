// Llama Manager Flasher — safe custom-titlebar command dispatcher.
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Defines the complete set of window operations the sandboxed renderer may
// request and applies one validated command to the originating Electron
// BrowserWindow. Keeping this dispatcher independent of Electron makes the
// frameless titlebar security boundary directly testable.

/** A command accepted from the renderer's custom titlebar. */
export type WindowControl = 'minimize' | 'maximize' | 'close';

/** Native window operations used by the custom-titlebar dispatcher. */
export interface WindowControlTarget {
  /** Minimizes the window to the operating system's task switcher or dock. */
  minimize(): void;
  /** Expands the window to the current display's working area. */
  maximize(): void;
  /** Returns a maximized window to its previous size and position. */
  restore(): void;
  /** Closes the window using Electron's normal close lifecycle. */
  close(): void;
  /** Reports whether the window is currently maximized. */
  isMaximized(): boolean;
}

/**
 * Applies an allow-listed custom-titlebar command to its owning window.
 *
 * @param command - Renderer-requested native window operation.
 * @param target - BrowserWindow-compatible target that originated the IPC.
 * @throws {Error} When untrusted renderer input is not an allowed command.
 */
export function dispatchWindowControl(
  command: WindowControl,
  target: WindowControlTarget,
): void {
  if (command === 'minimize') {
    target.minimize();
    return;
  }
  if (command === 'maximize') {
    if (target.isMaximized()) target.restore();
    else target.maximize();
    return;
  }
  if (command === 'close') {
    target.close();
    return;
  }
  throw new Error(`unsupported window control: ${String(command)}`);
}
