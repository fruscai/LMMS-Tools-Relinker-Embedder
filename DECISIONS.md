# Decisions

## 08-09-2026 - Shipping shape

Three tools, kept separate

- **Relinker** rewrites paths. **Embedder** writes audio into the project. **Relinker + Embedder**
  does both in one pass. They stay separate because they answer different questions — relinking
  fixes MY machine, embedding makes a file that works on someone ELSE'S. Tried thinking of it as
  one tool with modes and it made the choice harder to reason about, not easier.

Single HTML file over Electron

- The Electron build works fine, but it needs installing, and unsigned it trips Gatekeeper on macOS
  and SmartScreen on Windows. Windows also needs its own build and a signing cert. One HTML file is
  one download, no install, offline, and the same file runs on Mac, Windows and Linux.
- The one thing HTML genuinely can't do is bundling, because `makebundle` IS the LMMS binary and no
  web page can launch it. That's why the bundler stayed a desktop app and the embedder didn't have
  to be one.

Folder or ZIP only, no single file input

- Autosaves (`.mmpz.bak`) and `Files.txt` have to travel with the projects. Accepting a lone
  `.mmpz` would drop them without saying so.

Fixtures are generated now

- The test fixtures were a real project of mine, which is fine locally and not fine in a public
  repo. Replaced with a generated project. Still compressed by LMMS itself, so the `lmms -d`
  comparison and the byte-identity test keep their meaning — a fixture I compressed myself would
  prove nothing about LMMS.

## 08-08-2026 - Embedding instead of bundling

Why path-based fixes were never going to work

- The grading report said the same thing on every criterion: the project "opens with error dialogs
  into sampleless (0ms, empty display) instruments and can't play." LMMS found the references in
  the XML and no audio behind them.
- Relinking can't fix that. It points projects at a folder on MY machine, which doesn't exist on
  the grader's. Relinking solves my problem, not theirs.
- Bundling gets closer but needs `local:` (LMMS 1.3.0-alpha+, while 1.2.2 is still the last stable
  release) and needs the folder structure kept intact. Neither is guaranteed on a machine I don't
  control.

Embedding removes the dependency instead of redirecting it

- LMMS's own loader falls back to a base64 `sampledata` attribute when `src` is absent. Put the
  audio there and there's no path to resolve, no folder to preserve, no version requirement, no
  working-directory sensitivity.
- The cost is size. Audio goes in as raw float32 and every instrument carries its own copy, so a
  project with 3 samples used 18 times is about 28 MB. Took that deliberately. Correctness beat
  size here and disk is cheap.

Dedupe within a bundle, never across

- Sharing one resources folder between all the bundles would take 190 MB down to about 5 MB. Not
  doing it — every interim snapshot has to play on its own, and shared resources breaks that the
  moment one folder gets moved.
- No symlinks either. They can't hold repaired content, they break when a folder gets zipped or
  moved, and Windows needs elevated privileges to make them.

Verify before writing, always

- `makebundle` exits 0 while producing nothing when a project has an empty sample slot or already
  uses `local:`. A pipeline that trusts the exit code ships broken work and says it succeeded.
- So: check every reference resolves BEFORE bundling, and refuse the file rather than hand over
  something that looks fine and plays silence. That gate caught genuinely missing samples twice
  during development, once when I'd deleted the gig samples to test and forgotten.

## 08-06-2026 - The beginning

Never re-serialise the XML

- The obvious way to build this is parse the project into a DOM, change the paths, write it back.
  That reformats whitespace, reorders attributes and re-encodes entities across hundreds of
  projects, and I wouldn't find out for months.
- So the project gets treated as text and only the exact matched substring is replaced. A
  length-delta check rejects the file if anything else moved. Verified it: with sample paths masked
  out, original and relinked XML are byte-identical.

Deterministic only, no guessing

- No fuzzy matching, no searching the disk for similarly-named audio, no inferring where a sample
  probably lives. I give it the old root and the new root and it replaces exactly that.
- LMMS already reports the broken path, so the information is there without anyone guessing.

Match both slash directions, on by default

- LMMS stores Windows paths with forward slashes, so a pasted backslash path matches nothing at
  all. Without this the tool fails at the exact job it exists for.
- Kept it as a toggle instead of hard-wiring it, because a backslash is a legal filename character
  on macOS and Linux, so a strictly literal match is occasionally the right answer.

Non-destructive by default

- Source files only ever get read. Output goes to a separate tree named for what happened to it:
  `-RELINKED`, `-EMBEDDED`, `-RELINKED-EMBEDDED`. An existing result never gets overwritten, it
  gets a counter.
- Timestamps preserved on copies, so a bulk repair doesn't restamp a whole project library with
  today's date and wreck date sorting.

Compression layer before the GUI

- The format is the part that can silently corrupt work, so it got built and tested first, against
  real LMMS files, and proven by opening a generated `.mmpz` in LMMS before any interface existed.
