# Decisions

## 08-09-2026 - Shipping shape

Three separate tools, not one

- **Relinker** rewrites paths. **Embedder** writes audio into projects. **Relinker + Embedder**
  does both in one pass. They stay separate because they answer different questions: relinking
  fixes *my* machine, embedding makes a file that works on *someone else's*. Merging them into one
  mode-switching tool made the choice harder to reason about, not easier

Single-file HTML over Electron

- The Electron build works, but it needs installing, and on macOS an unsigned app trips Gatekeeper
  while Windows needs its own build and a signing certificate. A single HTML file is one download,
  no install, works offline, and runs on Mac, Windows and Linux from the same file
- The one thing HTML genuinely cannot do is bundling, because `makebundle` is the LMMS binary.
  That is why the bundler stayed a desktop app and the embedder did not have to

Folder or ZIP only, no single-file input

- Autosaves (`.mmpz.bak`) and `Files.txt` need to travel with the projects. Accepting a lone
  `.mmpz` would quietly drop them

Fixtures are synthetic now

- The test fixtures were a real project of mine. For a public repo that publishes my music, so they
  were replaced with a generated project. It is still compressed by LMMS itself, so the
  `lmms -d` comparison and the byte-identity test keep their meaning

## 08-08-2026 - Embedding over bundling

The problem with every path-based approach

- The grading report was consistent across every criterion: the project "opens with error dialogs
  into sampleless (0ms, empty display) instruments and can't play". LMMS found the sample
  references in the XML and no audio behind them
- Relinking cannot fix that. It points projects at a folder on *my* machine, which does not exist
  on the grader's
- Bundling is closer, but it needs `local:` (LMMS 1.3+, while 1.2.2 is still the last stable
  release) and needs the folder structure preserved. Neither is guaranteed

Embedding removes the dependency instead of redirecting it

- LMMS's own loader falls back to a base64 `sampledata` attribute when `src` is absent. Writing the
  audio there means there is no path to resolve, no folder to preserve, no version requirement, and
  no working-directory sensitivity
- Cost is size: audio is stored as raw float32, and each instrument carries its own copy, so a
  project with 3 samples used 18 times is ~28 MB. Accepted deliberately, because correctness beat
  size here

Dedupe within a bundle, never across

- Sharing one resources folder between bundles would cut 190 MB to 5 MB, and would break the
  requirement that every interim snapshot plays independently. Not worth it
- No symlinks either. They cannot hold repaired content, they break when a folder is moved or
  zipped, and Windows needs elevated privileges to create them

Verify before writing, always

- `makebundle` exits 0 while producing nothing when a project has an empty sample slot or already
  uses `local:`. A pipeline that trusts the exit code ships broken work
- So: check that every reference resolves before bundling, and refuse the file rather than produce
  a bundle that looks fine and plays silence. This gate caught genuinely missing samples twice
  during development

## 08-06-2026 - The beginning

Never re-serialise the XML

- The obvious way to build this is to parse the project into a DOM, change the paths, and write it
  back. That would silently reformat whitespace, reorder attributes and re-encode entities across
  hundreds of projects, and I would not find out for months
- So the project is treated as text and only the exact matched substring is replaced. A length-delta
  check rejects the file if anything else moved. Verified: with sample paths masked out, the
  original and relinked XML are byte-identical

Deterministic replacement only, no guessing

- No fuzzy matching, no searching the disk for similarly named audio, no inferring where a sample
  "probably" lives. The user supplies the old root and the new root, and only that is replaced
- LMMS already reports the broken path, so the information is available without guessing

Match both slash directions, on by default

- LMMS stores Windows paths with forward slashes, so a pasted backslash path matches literally
  nothing. Without this the tool fails at exactly the job it exists for
- It stays a toggle rather than being hard-wired, because a backslash is a legal filename character
  on macOS and Linux, so a strictly literal match is occasionally the right answer

Non-destructive by default

- Source files are only ever read. Output goes to a separate tree named for what happened to it:
  `-RELINKED`, `-EMBEDDED`, `-RELINKED-EMBEDDED`. An existing result is never overwritten
- Timestamps are preserved on copied files, so a bulk repair does not restamp a whole project
  library with today's date and destroy date sorting

Compression layer before the GUI

- The format is the part that can silently corrupt work, so it was built and tested first, against
  real LMMS files, and proven by opening a generated `.mmpz` in LMMS before any interface existed
