# Daily Log

## 08-09-2026

Tools

- Built the **Sample Embedder** as one standalone HTML file. Drop a folder or ZIP, get a
  `-EMBEDDED` folder back. Two modes: everything, or one final project. Every other file gets
  copied straight through
- Built the **Relinker + Embedder** as a second HTML file. Stage A relinks everything so it runs on
  my machine, Stage B embeds one project to send to the grader
- Neither one needs LMMS installed. Embedding is just data work — decompress, read the WAV, base64,
  rewrite the XML, recompress — and browsers do all of that natively now. Bundling is the opposite,
  it shells out to the LMMS binary, which is why that one has to stay a desktop app
- Swapped the test fixtures. They were a real project of mine. Now they're a generated project that
  LMMS itself compressed, so the `lmms -d` comparison and the byte-identity test still mean
  something and my music isn't sitting in a public repo

⚠️ The `usergig:` trap

- `path.basename("usergig:Snare Sounds.wav")` hands back the WHOLE string, prefix and all, because
  there's no slash after the colon. So the lookup missed and
  `Drumline_Orchestration_Final_V2` came out with **zero** samples embedded
- The run reported 86 written, 0 failed. Looked like a clean success. The only thing that gave it
  away was the `MISSING samples: 18` counter in the summary
- Lesson: keep that counter loud. A tool that reports "0 failed" while shipping a broken final
  project is worse than one that just crashes

Also fixed

- A project with no samples at all legitimately has an empty resources folder. My validator was
  calling that a failure. Only demand resources when the project actually asks for some

## 08-08-2026

makebundle, and what the docs don't say

- Built the bundle pipeline around `lmms makebundle`. Ran the real binary before writing anything,
  which corrected three things I'd assumed:
  - it's `lmms makebundle <in> [out]` — an ACTION, lowercase, not a `--makeBundle` flag
  - `.mmpz` input works directly, no decompress step needed
  - the output project is named after the **output argument**, not the source project
- LMMS copies a sample once per REFERENCE, not per unique file. One project with 3 samples used 18
  times shipped 18 copies. 4.5 MB of audio came out as a 29 MB bundle
- Added a dedupe step that groups by SHA-256 and collapses the identical copies. Across 44 projects
  that took 1,174 MB down to 182 MB
- Dedupe stays INSIDE one bundle. No shared resources folder, no symlinks, or the snapshots stop
  being independently playable, which was the whole point

Linux

- macOS is case-insensitive, Linux isn't. A reference to `Snare.wav` when the file on disk is
  `snare.wav` works fine on the machine that built it and plays nothing on the grader's
- Wrote a normalise step for it, then broke a bundle on purpose by renaming a resource to
  `snare sounds.WAV`. It got caught, corrected, re-audited clean, and still rendered

⚠️ Two ways makebundle fails while exiting 0

- **empty sample slot.** An `audiofileprocessor` with `src=""` (instrument loaded, no sample in it)
  makes it print `QFile::copy: Empty or null file name`, write NO project file, and exit 0. Three
  of my 44 snapshots hit this
- **rebundling.** Run makebundle on something that already uses `local:` and you get an empty
  resources folder, no project file, exit 0
- Both look like success from the outside. Anything scripting makebundle has to check the output
  exists instead of trusting the exit code

BIG ONE: embedding

- Bundles need `local:`, which needs LMMS 1.3+, and they need the folder kept intact. Neither is
  guaranteed on a grader I don't control
- Found `sampledata` in the LMMS source. It's a base64 slot the loader falls back to **when `src`
  is absent**. Put the audio in there and there's no path to resolve at all
- **`src` WINS over `sampledata`.** It has to be REMOVED, not blanked, or LMMS ignores the embedded
  audio and reports a missing file
- Proved it: rendered from `/` with no sample files anywhere on the machine, audio came out
  byte-identical to the bundle version
- Worried the sample rate would break it, since the base64 carries no rate metadata. Tested instead
  of guessing — embedded and file-based renders are byte-identical at 44.1 kHz AND 48 kHz. Concern
  was unfounded
- Embedded all 44 snapshots plus the 42 `.mmpz.bak` autosaves. 1,445 samples in, 0 missing

⚠️ Bare relative paths look like they work

- Tried `src="Snare Sounds.wav"` with the WAV sitting next to the project. Worked perfectly when I
  ran LMMS from that folder. Ran it from `/` and got PURE SILENCE, peak 0
- It resolves against the WORKING DIRECTORY, not the project file. `local:` is the only prefix
  anchored to the project
- Would have shipped this if I hadn't tested from a different folder

## 08-06-2026

The format

- `.mmpz` is Qt `qCompress`: 4-byte big-endian uncompressed length, then a plain zlib stream. Not
  gzip, not a ZIP. Checked it on real files instead of taking anyone's word
- Our decompression is SHA-256 identical to `lmms -d`. The CLI tacks on one trailing newline that
  isn't part of the stored bytes
- Our compression came out **byte-identical** to LMMS's own output on 12 real projects. Node's zlib
  default matches Qt's `qCompress` default

BIG ONE: forward slashes

- **LMMS stores Windows paths with FORWARD slashes.** A project that broke on
  `C:\Users\...\Audio Files\` is sitting in the file as `C:/Users/.../Audio Files/`
- So pasting the path straight out of the LMMS error dialog matches literally nothing. Which is the
  exact thing this tool exists to do
- Handled by matching both slash directions, on by default, with the matched form shown in the
  preview so nothing happens invisibly

Build

- Compression layer first, GUI last. 45 tests against real LMMS fixtures
- Electron app, then a single-file HTML version. The HTML one is what actually gets used — no
  install, works offline, nothing uploaded
- Didn't call it done until a generated `.mmpz` opened in LMMS and rendered to a 44 MB WAV

⚠️ Traps

- Nearly built this by parsing the XML into a DOM and writing it back. That quietly reformats
  whitespace, reorders attributes and re-encodes entities across every project and you don't find
  out for months. Text replacement only now, with a length-delta check that rejects the file if
  anything other than the requested root moved
- `[hidden]` in HTML loses to any class that sets `display`, so panels stayed on screen when they
  should have been closed
- Left the replacement path blank once and the scan happily previewed stripping the root off every
  path. Both fields required now
