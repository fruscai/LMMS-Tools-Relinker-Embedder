# Decisions

## 08-09-2026 - Shipping shape

Three tools rather than one

- Keeping the relinker, the embedder and the combined relink-and-embed as three separate tools,
  because they answer different questions and merging them into one tool with modes made the choice
  harder rather than easier. Relinking fixes the paths on my own machine so I can open and work on
  the projects. Embedding produces a file that works on a machine I have no control over. Those are
  different jobs and the tool should not pretend otherwise.
- The combined one exists because the normal workflow genuinely needs both in sequence: relink
  everything so the set is workable locally, then embed the single final project that gets sent
  out.

Single HTML file rather than Electron

- The Electron build works, but it needs installing, and unsigned it trips Gatekeeper on macOS and
  SmartScreen on Windows, plus Windows needs its own separate build and a signing certificate. A
  single HTML file is one download with no install, runs offline, and the identical file works on
  macOS, Windows and Linux.
- The one thing an HTML page genuinely cannot do is bundling, because `makebundle` is the LMMS
  binary and no web page can launch it. That is the reason the bundler stayed a desktop app while
  the embedder did not have to be one, since embedding is pure data transformation that browsers
  can already do.

Folder or ZIP input only, no single file

- Autosaves (`.mmpz.bak`) and the `Files.txt` files have to travel with the projects, and accepting
  a single `.mmpz` on its own would drop them without saying anything. Restricting the input to a
  folder or a ZIP means whatever came in goes back out.

Generated fixtures

- The test fixtures were a real project of mine, which was fine while this was local and not fine
  once the repo went public. Replaced with a generated project of the same structure with the music
  removed.
- The generated XML is still compressed by LMMS itself rather than by our own compressor, because
  the `lmms -d` comparison and the byte-identity test only prove something if the fixture is real
  LMMS output. Compressing the fixture with our own code would reduce those tests to checking our
  code against itself.

## 08-08-2026 - Embedding instead of bundling

Why the path-based approaches were never going to survive

- The grading report said the same thing against every criterion, that the project "opens with
  error dialogs into sampleless (0ms, empty display) instruments and can't play". LMMS was reading
  the sample references out of the XML and finding no audio behind any of them.
- Relinking cannot fix that, because it points the projects at a folder on my machine which does
  not exist on the grader's. It solves my problem and not theirs, and it looks like it worked
  because everything opens correctly here.
- Bundling gets closer, but it depends on `local:` which needs LMMS 1.3.0-alpha while 1.2.2 is
  still the last stable release, and it depends on the folder structure surviving. Neither can be
  guaranteed on a machine I do not control.

Embedding removes the dependency rather than redirecting it

- LMMS's own loader falls back to a base64 `sampledata` attribute when `src` is absent, so writing
  the audio into that attribute leaves nothing to resolve. No path, no folder, no version
  requirement, no sensitivity to the working directory.
- The cost is size, since the audio goes in as raw float32 and each instrument carries its own copy
  rather than sharing one, so a project using three samples across eighteen instruments comes to
  about 28 MB. Took that deliberately, because correctness matters here and disk is cheap.

Dedupe within a bundle and never across

- Sharing one resources folder between all the bundles would take 190 MB down to roughly 5 MB, and
  it is not worth doing. Every interim snapshot has to play on its own, and a shared folder breaks
  that the moment one bundle is moved or sent on its own.
- Symlinks are out for the same reason, plus they cannot hold repaired content, they break when a
  folder is zipped or copied, and creating them on Windows needs elevated privileges.

Verify before writing

- `makebundle` exits 0 while producing nothing when a project contains an empty sample slot or
  already uses `local:` references, so a pipeline that trusts the exit code will ship broken work
  and report that it succeeded.
- The rule is therefore to confirm every reference resolves before bundling, and to refuse the
  project rather than produce a bundle that looks complete and plays silence. That gate caught
  genuinely missing samples twice during development, once when the gig folder samples had been
  deleted for a test and not put back.

## 08-06-2026 - The beginning

Never re-serialise the XML

- The obvious way to build this is to parse the project into a DOM, change the paths and write it
  back out. Doing that reformats whitespace, reorders attributes and re-encodes entities across
  every project touched, and none of that is visible until much later.
- The project is therefore treated as text and only the exact matched substring is replaced, with a
  length-delta check that rejects the file if anything other than the requested root moved.
  Verified by masking out the sample paths and confirming the original and relinked XML are
  byte-identical everywhere else.

Deterministic replacement with no guessing

- No fuzzy matching, no searching the disk for similarly named audio, no inferring where a sample
  probably belongs. The old root and the new root are both supplied and only that is replaced.
- LMMS already reports the broken path when it fails to load a project, so the information needed
  is already in front of the user and nothing has to be guessed at.

Match both separator directions, on by default

- LMMS stores Windows paths with forward slashes, so a pasted backslash path matches nothing and
  the tool fails at the exact job it exists to do. Matching both directions is what makes the
  normal workflow work at all.
- It stays a toggle rather than being hard-wired, because a backslash is a legal character in a
  filename on macOS and Linux, so a strictly literal match is occasionally the correct behaviour.

Non-destructive by default

- Source files are only ever read and output goes to a separate tree, named for what was done to it
  so the folder itself records the process: `-RELINKED`, `-EMBEDDED`, `-RELINKED-EMBEDDED`. An
  existing result is never overwritten, it gets a counter appended instead.
- Timestamps are preserved on everything copied through, because a bulk repair that restamps a
  whole project library with today's date destroys date sorting across months of work.

Compression layer before the interface

- Built and tested the format handling first, against real LMMS files, and proved a generated
  `.mmpz` would open in LMMS before any interface existed. The format is the part that can silently
  corrupt work, whereas an interface bug announces itself.
