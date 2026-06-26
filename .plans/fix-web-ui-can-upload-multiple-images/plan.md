# Plan: Fix the webui so multiple images can be uploaded in one go

## Goal

When a user selects several images at once via the OS file picker (the GUI portal),
the webui must attach *all* of them, not just the first. The same must hold for
drag-and-drop of multiple files. Today exactly one image survives no matter how
many are chosen.

## Root cause (confirmed by reading the code)

The `<input type="file" id="image-input" accept="image/*" multiple>` in
`public/index.html` already has `multiple`, and `addAttachments()` already loops
over every file and pushes into the `pendingImages` array. The data model and the
send path support arrays end-to-end (`images?: PendingImage[]` in
`src/public/app-types.ts`, and `sendMessage()` maps all `pendingImages` into
`cmd.images`). So selection and transport are fine.

The bug is a race in the `change` handler in `src/public/app-main.ts` (~line 1094):

```ts
imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files ?? []);   // async, NOT awaited
  imageInput.value = '';                    // runs synchronously, right now
});
```

`addAttachments()` is `async`. It is called with `imageInput.files`, which is a
**live `FileList`** reference. The call returns a promise immediately, then the
handler synchronously runs `imageInput.value = ''`, which clears the input and
**empties that live `FileList`**. Meanwhile inside `addAttachments` the
`for (const file of files)` loop has pulled the first file and is suspended at
`await processImageFile(file)`. When it resumes and asks the iterator for the
next file, the `FileList` is already empty, so the loop ends. Result: only the
first selected image is ever processed — exactly the reported symptom.

The drag-and-drop handler has a latent version of the same bug: it passes
`e.dataTransfer.files` (also a live `FileList`), which browsers invalidate once
the event handler returns. The paste handler is already safe because it builds
its own plain `File[]` array.

## Fix

Snapshot the `FileList` into a plain `Array` **before** any `await` runs, so
clearing the input (or the `DataTransfer` being invalidated) cannot truncate the
loop. The single best place is the top of `addAttachments`, because it covers all
three entry points (change, drop, paste) in one edit.

### 1. `src/public/app-main.ts` — `addAttachments()` (~line 1080)

Change the function to copy the incoming list into a static array first, then
iterate that array:

```ts
async function addAttachments(files: FileList | File[]) {
  const list = Array.from(files);            // snapshot before any await
  for (const file of list) {
    if (!file.type.startsWith('image/')) continue;
    try {
      pendingImages.push(await processImageFile(file));
    } catch (e) {
      console.error('[Tau] Image processing failed:', e);
    }
  }
  renderAttachmentPreviews();
}
```

No change is required to the `change`, `drop`, or `paste` handlers — passing a
live `FileList` is now safe because it is copied synchronously on the first line
of `addAttachments`, before the first `await` suspends. (`imageInput.value = ''`
stays; it is still needed so the user can re-select the same file later.)

### 2. `public/app-main.js` — regenerate the committed compiled output

The repo commits the built JS (`public/*.js`), and `public/app-main.js`
currently contains the same buggy handler (confirmed at line 1011). After editing
the source, run:

```
npm run build
```

(`tsc -p tsconfig.server.json && tsc -p tsconfig.public.json`). Verify that
`public/app-main.js` now contains the `Array.from(...)` snapshot inside
`addAttachments`.

## Verification

1. `npm run typecheck` — must pass with no errors.
2. `npm run build` — must succeed; confirm `public/app-main.js` reflects the
   snapshot.
3. Manual browser smoke test (no automated DOM test harness exists in this repo —
   the `test/` suite is `node --test` server-side only, with no jsdom/playwright):
   - Start the server, open the webui, click the attach button, and select **3+
     images** at once from the OS file picker. Confirm all of them appear as
     preview chips and that all of them are sent with the next message.
   - Drag-and-drop **3+ images** onto the message input; confirm all are
     attached.
   - Select the same single image twice in a row (regression check that
     `imageInput.value = ''` still lets the same file be re-picked).
   - Remove a chip mid-set and re-send; confirm the remaining images still send.

## Out of scope / notes

- No new automated test is added because there is no browser/DOM test harness in
  the project. If desired later, a small jsdom + fake-`FileList` unit test around
  `addAttachments`/the `change` handler would lock this in, but that requires
  adding a DOM shim dependency, which is a separate decision.
- The server side and the `PendingImage[]` types already handle arrays, so no
  server changes are needed.
