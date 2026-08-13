# LMMS Path Relinker + Sample Embedder

Fix broken sample paths in LMMS projects, or write the audio into the project so it plays on a
machine that doesn't have the files.

Runs locally. Nothing gets uploaded.

## The problem

An LMMS project stores a file PATH for each sample. Move the project to another machine, or
reinstall, and LMMS finds nothing at that path. You get instruments that load empty and make no
sound.

Two situations, two different fixes:

| Situation | Tool |
|---|---|
| Samples are on this machine, just somewhere else | **Relinker** |
| Sending the project to someone else | **Embedder** |

Relinking fixes YOUR machine. Embedding makes a file that works anywhere.

## The tools

Single HTML files. No install. Open one in a browser, works offline.

**`web/lmms-path-relinker.html`** — rewrites sample path roots across hundreds of projects at once.
Give it the broken folder and the correct one. Scan first, it's read-only and shows exactly what
will change.

**`web/lmms-sample-embedder.html`** — writes the audio INTO the project file, so there's nothing
left to resolve. No sample folder, no `resources` folder, no path to break. Writes both `sampledata`
and `srcdata`, so the audio plays in 1.2 and 1.3 alike. The project body still has to be 1.2 shaped
for 1.2 to open it at all, which means authored there rather than round-tripped through 1.3. Embed
everything, or just one final project.

**`web/lmms-tools.html`** — both tools in one file, on two tabs. They are independent: Relink for a
whole folder of projects, Embed for the one final project going out. Neither tab needs the other to
have run first.

Output folders are named for what ran: `-RELINKED`, `-EMBEDDED`, `-RELINKED-EMBEDDED`.

Use Chrome, Brave or Edge. Large jobs write straight to a folder you pick. Safari 16.4+ and Firefox
113+ work for smaller jobs and give you a ZIP instead.

## Command line

```bash
npm install
npm test                                              # 45 tests

node tools/list-paths.js <folder|zip>                 # what roots are actually in there
node tools/scan-cli.js <source> <old> [new]           # read-only scan
node tools/embed-batch.js <tree> <sampleDir>          # embed across a whole tree
node tools/bundle-batch.js <tree> [out] --strip-empty # lmms makebundle + dedupe
```

There's an Electron build too (`npm start`) that does the relinking.

## Things worth knowing about LMMS

All of this was checked against the real binary and real project files, not assumed. More in
[`docs/LMMS_FORMAT_NOTES.md`](docs/LMMS_FORMAT_NOTES.md).

**LMMS stores Windows paths with FORWARD slashes.** A project that broke on
`C:\Users\You\Desktop\Audio\` is sitting in the file as `C:/Users/You/Desktop/Audio/`. So pasting
the path straight out of the LMMS error dialog matches nothing. These tools match both directions.

**`.mmpz` is Qt `qCompress`** — 4-byte big-endian uncompressed length, then a plain zlib stream.
Not gzip, not a ZIP archive.

**`src` beats `sampledata`.** To embed audio the `src` attribute has to be REMOVED, not blanked, or
LMMS ignores what you embedded and reports a missing file.

**`makebundle` fails while exiting 0.** It writes no project file when the project has an empty
sample slot (`src=""`), or when it already uses `local:` references. Anything scripting it has to
check the output exists. The exit code lies.

**Bare relative paths resolve against the working directory**, not the project file. They look like
they work when you run LMMS from the project's own folder and give you silence anywhere else. Only
`local:` is anchored to the project.

**`local:` needs LMMS 1.3.0-alpha or later.** 1.2.2 is still the last stable release, which is why
embedding travels better than bundling.

## Safety

- Source files only ever get read. Output goes to a separate tree
- Scanning never modifies anything
- Every `.mmpz` written gets decompressed again and compared byte-for-byte against the intended XML
  before you get it
- The XML never gets re-parsed and re-serialised, so whitespace, attribute order, entity encoding
  and line endings survive. A length-delta check rejects the file if anything other than the
  requested path moved
- ZIP input is protected against ZIP-slip, absolute paths, symlink entries and decompression bombs
- Timestamps are preserved, so a bulk repair doesn't restamp your whole project library with
  today's date

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

## Doing this inside LMMS instead

[lmms-embed-samples](https://github.com/fruscai/lmms-embed-samples) is a patch that adds embedding
to LMMS itself, as a checkbox in the Save As dialog and an `lmms embedsamples <in> <out>` command.
It covers more than these tools do: SlicerT, TripleOscillator user waves, and the envelope and LFO
user waves that no LMMS version could embed before.

It is LMMS 1.3 only. Anything saved by it is a 1.3 project, so **for LMMS 1.2 use the embedder
here**, which writes `srcdata` alongside `sampledata`.

[`LOG.md`](LOG.md) and [`DECISIONS.md`](DECISIONS.md) have how this got built and why.
[`docs/LEXICON.md`](docs/LEXICON.md) is how the writing in here is meant to read.

## License

MIT
