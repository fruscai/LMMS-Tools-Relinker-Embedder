# LMMS Path Relinker + Sample Embedder

Tools for fixing broken sample paths in LMMS projects, and for making projects play on any
machine without their original audio files.

Everything runs locally. Nothing is uploaded.

## The problem

An LMMS project stores a file **path** for each sample. Move the project to another machine, or
reinstall, and LMMS finds nothing at that path. You get instruments that load empty and produce
no sound.

Two different fixes, for two different situations:

| Situation | Tool |
|---|---|
| Samples are on this machine, just somewhere else | **Relinker** |
| Sending the project to someone else | **Embedder** |

Relinking fixes your machine. Embedding makes a file that works anywhere.

## The tools

Single HTML files. No install. Open one in a browser and it works offline.

### `web/lmms-path-relinker.html`

Rewrites sample path roots across hundreds of projects at once. Give it the broken folder and the
correct one. Scan first, which is read-only and shows exactly what will change.

### `web/lmms-sample-embedder.html`

Writes the audio **into** the project file, so there is nothing left to resolve. No sample folder,
no `resources` folder, no path to break. Works on any LMMS version.

Embed everything in a folder, or just one final project.

### `web/lmms-relink-embed.html`

Both, in one pass. Stage A relinks every project so it runs locally. Stage B embeds one chosen
project to send elsewhere.

Output is named for what ran: `-RELINKED`, `-EMBEDDED`, or `-RELINKED-EMBEDDED`.

**Browser support:** Chrome, Brave or Edge recommended. Large jobs write straight to a folder you
pick. Safari 16.4+ and Firefox 113+ work for smaller jobs and produce a ZIP.

## Command line

```bash
npm install
npm test                                              # 45 tests

node tools/list-paths.js <folder|zip>                 # what roots are actually stored
node tools/scan-cli.js <source> <old> [new]           # read-only scan
node tools/embed-batch.js <tree> <sampleDir>          # embed across a tree
node tools/bundle-batch.js <tree> [out] --strip-empty # lmms makebundle + dedupe
```

There is also an Electron build (`npm start`) with the same relinking behaviour.

## Things worth knowing about LMMS

All verified against the real binary and real project files. Details in
[`docs/LMMS_FORMAT_NOTES.md`](docs/LMMS_FORMAT_NOTES.md).

**LMMS stores Windows paths with forward slashes.** A project that broke on
`C:\Users\You\Desktop\Audio\` is stored as `C:/Users/You/Desktop/Audio/`. Pasting the path
straight out of LMMS's error dialog matches nothing literally. The tools match both directions.

**`.mmpz` is Qt `qCompress`:** a 4-byte big-endian uncompressed length followed by a plain zlib
stream. Not gzip, not a ZIP archive.

**`src` beats `sampledata`.** To embed audio, the `src` attribute has to be removed, not blanked,
or LMMS ignores the embedded audio and reports a missing file.

**`makebundle` can fail silently.** It exits 0 while writing no project file when the project has
an empty sample slot (`src=""`), or when it already uses `local:` references. Anything scripting it
must check that output exists rather than trust the exit code.

**Bare relative paths resolve against the working directory**, not the project file. They appear to
work when you run LMMS from the project's folder and produce silence otherwise. Only `local:` is
anchored to the project.

**`local:` needs LMMS 1.3.0-alpha or later.** 1.2.2 is still the last stable release, which is why
embedding is the more portable option.

## Safety

- Source files are only ever read. Output goes to a separate tree
- Scanning never modifies anything
- Every `.mmpz` written is decompressed again and compared byte-for-byte with the intended XML
  before it is handed over
- The XML is never re-parsed and re-serialised, so whitespace, attribute order, entity encoding and
  line endings are preserved. A length-delta check rejects the file if anything other than the
  requested path moved
- ZIP input is protected against ZIP-slip, absolute paths, symlink entries and decompression bombs
- Timestamps are preserved, so a bulk repair does not restamp a project library with today's date

## Layout

```
src/core/     mmpz  mmp  pathReplace  scanner  zip  validator  report  engine
              bundle  embed  naming
src/main/     Electron main process
src/renderer/ Electron UI
web/          the three standalone HTML tools
tools/        CLI utilities
tests/        45 tests + fixtures
docs/         format notes, testing notes, bundling notes
```

`src/core` has no UI or Electron dependencies.

See [`LOG.md`](LOG.md) and [`DECISIONS.md`](DECISIONS.md) for how this was built and why.

## License

MIT
