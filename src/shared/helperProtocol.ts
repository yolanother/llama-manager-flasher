// Llama Manager Flasher — helper control-channel protocol (framing + types).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Pure, dependency-free wire format for the launcher <-> elevated-helper
// channel: newline-delimited JSON. The launcher sends HelperCommand; the helper
// replies with HelperReply. The first line the helper sends is AuthMessage.

/** First line the helper sends after connecting; proves it holds the token. */
export interface AuthMessage {
  type: 'auth';
  token: string;
}

/** Commands sent launcher -> helper. `id` correlates replies to a request. */
export type HelperCommand =
  | { id: number; type: 'scan' }
  | { id: number; type: 'flash'; devicePath: string; imagePath: string; typedConfirmation: string }
  | { id: number; type: 'cancel' }
  | { id: number; type: 'ping' };

/** Write/verify progress the helper streams during a flash. */
export interface HelperFlashProgress {
  phase: string;
  bytesWritten: number;
  size: number;
  speed: number;
  percentage: number;
  error?: string;
}

/** Replies sent helper -> launcher, correlated by the originating command id. */
export type HelperReply =
  | { id: number; kind: 'progress'; progress: HelperFlashProgress }
  | { id: number; kind: 'result'; result: unknown }
  | { id: number; kind: 'error'; error: string };

/** Serializes a message as one newline-terminated JSON line. */
export function encodeMessage(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Stateful newline splitter that yields parsed objects as lines complete. */
export function createFramer(): { push(chunk: string): unknown[] } {
  let buffer = '';
  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      return parts.filter((line) => line.length > 0).map((line) => JSON.parse(line));
    },
  };
}
