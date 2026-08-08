# LMMS Path Relinker

Bulk-repair broken external audio-file paths inside LMMS `.mmp` and `.mmpz`
projects, without opening and resaving each project in LMMS.

Everything runs locally. No project or sample data is uploaded anywhere.

## What it does

1. Reads `.mmp` (XML) and `.mmpz` (Qt `qCompress` container) projects.
2. Recovers the original XML bytes.
3. Replaces exactly the path root you specify.
4. Preserves everything else, byte for byte.
5. Recompresses `.mmpz` using the real LMMS-compatible container.
6. Verifies every produced file decompresses back to the intended bytes before
   writing it.
7. Returns repaired projects in the same format and folder structure.

It is a deterministic path substitution utility, not a sample finder. It never
guesses where a missing sample belongs.

## Install and run

```bash
npm install
npm start
```

```bash
npm test
```

## Using it

1. Drop a folder or ZIP onto the window, or use the Browse buttons.
2. Paste the broken folder path into **Incorrect path**.
3. Enter the correct root into **Replacement path**.
4. Press **Scan** — nothing is modified, and you see exactly what will change.
5. Press **Repair**.

Output goes to a new location beside the source: `ProjectFolder_RELINKED`,
`Bundle_RELINKED.zip` or `project_RELINKED.mmpz`. Originals are never touched,
and an existing result is never overwritten.

### Finding the right "incorrect path"

If a scan reports zero matches, the root you pasted is not what is stored in
the files. To see what is actually there:

```bash
node tools/list-paths.js /path/to/folder-or-bundle.zip
```

This reports the roots present in the projects, and nothing else.

### Windows paths: the slash gotcha

**LMMS stores Windows paths with forward slashes.** A project that broke on
`C:\Users\You\Desktop\Audio\` is stored in the file as `C:/Users/You/Desktop/Audio/`.

So a strictly literal search for the path you pasted would find nothing. The
**"Also match the other slash direction"** option (on by default) handles this,
and the preview tells you which form actually matched. When it matches a
swapped form, the replacement is written with that same separator style, so a
repaired path never mixes `/` and `\`.

Turn the option off if you need a strictly literal match.

### What is never touched

`factorysample:`, `usersample:`, `usergig:` and `usersoundfont:` references are
resolved by LMMS itself and are left alone — the tool only replaces the exact
root you supply.

## Safety

- Scanning never modifies input.
- Repair writes to a separate output tree; the source is read-only.
- Before any `.mmpz` is written, it is decompressed again in memory and compared
  byte-for-byte with the intended XML. A mismatch means nothing is written.
- Files that are not valid UTF-8 are refused rather than corrupted.
- A length-delta check rejects any file where something other than the requested
  root changed.
- ZIP input is protected against ZIP-slip, absolute paths, symlink entries and
  decompression bombs.
- Nothing inside a project folder is ever executed.

## Reports

Every repair writes a JSON log plus human-readable text and CSV summaries
alongside the output: timestamp, version, source, output, per-file format,
occurrence counts, decompression / recompression / round-trip status and result.
Audio file contents never appear in a log.

## Project layout

```
src/core/     mmpz.js  mmp.js  pathReplace.js  scanner.js  zip.js
              validator.js  report.js  engine.js
src/main/     main.js  ipc.js  preload.js
src/renderer/ index.html  app.js  styles.css
tools/        list-paths.js  scan-cli.js
tests/        mmpz.test.js  replacement.test.js  batch.test.js  fixtures/
docs/         LMMS_FORMAT_NOTES.md  TESTING.md
```

`src/core` has no UI or Electron dependencies.

## Format and verification

See [docs/LMMS_FORMAT_NOTES.md](docs/LMMS_FORMAT_NOTES.md) for the verified
container format, and [docs/TESTING.md](docs/TESTING.md) for test results,
including confirmation that a generated `.mmpz` loads and renders in LMMS.

## Not in V1

No fuzzy matching, sample discovery, hash matching, other DAW formats, plugin
relocation, audio conversion, cloud storage, accounts or database. The core is
structured so multiple path mappings and other backends can be added later.

## License

MIT — see [LICENSE](LICENSE).
