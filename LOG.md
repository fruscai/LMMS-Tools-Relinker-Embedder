# Daily Log

## 08-09-2026

Tools

- Built the **Sample Embedder** as a standalone HTML file. Folder or ZIP in, `-EMBEDDED` out.
  Two scopes: everything, or one final project. All other files copied through unchanged
- Built the **Relinker + Embedder** as a second HTML file. Stage A relinks every project so it
  runs on my own machine, Stage B embeds one chosen project to send to the grader. Output is
  named `-RELINKED` or `-RELINKED-EMBEDDED` depending on what actually ran
- Neither needs LMMS installed. Embedding is pure data work: decompress, decode WAV, base64,
  rewrite XML, recompress. Browsers do all of it natively
- Replaced the test fixtures. They used to be a real project of mine; now they are a synthetic
  project that LMMS itself compressed, so the `lmms -d` and byte-identity tests stay honest
  without publishing my music

Traps found

- `path.basename("usergig:Snare Sounds.wav")` returns the whole string, prefix included, because
  there is no slash after the colon. That silently left `Drumline_Orchestration_Final_V2` with
  **zero** samples embedded while the run reported 86 written and 0 failed. The only reason I
  caught it was the `MISSING samples: 18` line in the summary. Worth keeping that counter loud
- A project with no samples at all legitimately produces an empty resources folder. My validator
  was calling that a failure. Fixed: only demand resources when the project actually references some

## 08-08-2026

Bundling

- Built the bundle pipeline around `lmms makebundle`. Verified against the real binary, which
  corrected three things in my original spec: the syntax is `lmms makebundle <in> [out]` (an
  action, lowercase, not `--makeBundle`), `.mmpz` input works directly with no decompress step,
  and the output project is named after the **output argument**, not the source project
- LMMS copies a sample once per **reference**, not per unique file. One project with 3 samples used
  18 times shipped 18 copies: 4.5 MB of audio became a 29 MB bundle. Added a dedupe step that
  groups by SHA-256 content hash and collapses identical copies. Across 44 projects that took
  1,174 MB down to 182 MB
- Dedupe is strictly **within** one bundle. Never a shared resources folder, never symlinks, or the
  snapshots stop being independently playable
- Added a Linux normalisation step. macOS is case-insensitive and Linux is not, so a reference to
  `Snare.wav` when the file is `snare.wav` works on the machine that built it and silently plays
  nothing on the grader's. Tested by deliberately renaming a resource; it was detected, corrected,
  re-audited clean, and still rendered

Two silent failures in LMMS, both exit 0

- **Empty sample slots.** An `audiofileprocessor` with `src=""` (an instrument with no sample
  loaded) makes makebundle log `QFile::copy: Empty or null file name`, write no project file, and
  exit 0. Three of my 44 snapshots hit this
- **Rebundling.** Running makebundle on a project that already uses `local:` references produces an
  empty resources folder, no project file, and exit 0. Always bundle from the relinked source,
  never from a bundle

The thing that actually worked

- Bundles need `local:`, which needs LMMS 1.3+, and need the folder kept intact. Neither is
  guaranteed on a grader. Found `sampledata` in the LMMS source: a base64 slot the loader falls
  back to **when `src` is absent**. Embedding the audio there gives a single self-contained `.mmpz`
  with no paths, no folder, and no version requirement
- `src` WINS over `sampledata`. It has to be removed, not blanked, or the embedded audio is ignored
- Proved it: rendered from `/` with no sample files anywhere on the machine, audio byte-identical
  to the bundle version
- Also tested the sample-rate worry and it was unfounded. Embedded and file-based renders are
  byte-identical at both 44.1 kHz and 48 kHz
- Embedded all 44 snapshots plus the 42 `.mmpz.bak` autosaves. 1,445 samples embedded, 0 missing

Bare relative paths are a trap

- `src="Snare Sounds.wav"` with the WAV sitting next to the project worked perfectly when I ran
  LMMS from that folder, and produced **pure silence** when run from `/`. It resolves against the
  working directory, not the project file. `local:` is the only prefix anchored to the project

## 08-06-2026

Format research

- Confirmed `.mmpz` is Qt `qCompress`: a 4-byte big-endian uncompressed length, then a plain zlib
  stream. Not gzip, not ZIP. Verified on real files rather than assumed
- Our decompression is SHA-256 identical to `lmms -d`. The CLI adds one trailing newline that is
  not part of the stored bytes
- Our compression is **byte-identical** to LMMS's own output on 12 real projects. Node's zlib
  default matches Qt's `qCompress` default here

The finding that mattered most

- **LMMS stores Windows paths with forward slashes.** A project that broke on
  `C:\Users\...\Audio Files\` is stored as `C:/Users/.../Audio Files/`. So pasting the path
  straight out of LMMS's error dialog matches nothing. Handled by matching both slash directions,
  on by default, with the matched form shown in the preview

Build

- Core modules first, GUI last, per the plan. 45 tests, real LMMS fixtures
- Electron app, then a standalone single-file HTML version. The HTML one is what people actually
  use: no install, works offline, nothing uploaded
- Proved a generated `.mmpz` opens in LMMS by rendering it to a 44 MB WAV, not by assuming

Traps found

- Nearly built the tool by parsing the XML into a DOM and writing it back. That would have quietly
  reformatted whitespace, reordered attributes and re-encoded entities across every project.
  Narrow textual replacement only, with a length-delta check that rejects the file if anything
  other than the requested root moved
- `[hidden]` in HTML loses to any class that sets `display`, so panels stayed visible when they
  should have been closed
- Leaving the replacement path blank made the scan preview stripping the root off every path.
  Both fields are required now
