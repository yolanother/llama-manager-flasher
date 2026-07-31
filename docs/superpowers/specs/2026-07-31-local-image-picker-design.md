# Local image picker — design

Date: 2026-07-31

## Goal

Let the user flash an image they already have on disk instead of downloading
one, chosen from the main (platform) page.

## Decisions (from brainstorming)

- **Placement:** a secondary block below the two platform cards — not a third
  card. Keeps the download-first flow prominent.
- **Checksum:** optional. The user may paste an expected SHA-256 to verify the
  local file before writing; if omitted, verification is skipped (the write
  step still does its own post-write verify).
- **File types:** `.iso`, `.img`, `.xz` (matches what `flash.start` already
  supports; `.xz` is decompressed on write).

## Flow

Platform page → "Choose a downloaded image…" button opens the native file
dialog. On selection an inline panel on the same page shows the filename +
size, an optional SHA-256 input, and a **Continue** button → the existing
drive step → confirm → progress → done. No new wizard step.

## Renderer

Broaden the existing `image` state to `ApplianceImage | LocalImage | null`:

```ts
interface LocalImage {
  kind: 'local';
  file: string;
  size: number | null;
  path: string;
  sha256: string; // user-entered expected hash, '' when none
}
```

A type guard `isLocalImage(image)` discriminates (ApplianceImage has no
`kind`). Keeping the `image` / `setImage` names preserves existing tests. The
drive/confirm/progress steps already read only `file` and `size`, which both
shapes carry; version/channel display is guarded to the download shape.

`startFlash` branches on the guard:

- Local + SHA provided → `image.verifyLocal({ path, sha256 })` (shows the
  "Verifying checksum" phase, reuses `sha256File`, throws on mismatch) → write.
- Local + no SHA → write the chosen path directly.
- Download (unchanged) → `image.download(...)` → write.

For a local image the download/checksum phase chips are hidden; progress
starts at "Writing to device".

## Main process (`src/main/index.ts`)

Two new IPC handlers:

- `image:choose` → `dialog.showOpenDialog(mainWindow, { properties:
  ['openFile'], filters: [{ name: 'Disk images', extensions: ['iso','img','xz']
  }, { name: 'All files', extensions: ['*'] }] })`. Returns
  `{ path, file, size } | null` (size via `fs.stat`, `file` via
  `path.basename`). The path is user-selected via the native dialog — no new
  privilege beyond what `flash.start` already accepts.
- `image:verifyLocal` → stats the file, emits a `verifying`
  `image:download:progress` event, hashes via `sha256File`, throws on
  mismatch (case-insensitive, trimmed), returns the path.

## Preload + types

Add `image.choose()` and `image.verifyLocal({ path, sha256 })` to the
`llamaFlasher` bridge (`src/preload/index.cts`) and both renderer type mirrors
(`src/renderer/types.d.ts`).

## Safety

Unchanged. Every device-side rail (removable-only, 2 TiB cap,
re-enumerate-and-match, typed destructive confirmation) still runs in the main
process. Writing a user-chosen image to a removable drive is the intended
action.

## Tests

- Preload/types expose `image.choose` and `image.verifyLocal`.
- `isLocalImage` guard behaves for both shapes.
- App source: local-file entry on the platform page; download/checksum phase
  chips hidden for a local image.
