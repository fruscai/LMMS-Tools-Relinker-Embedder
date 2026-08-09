# Bundling

Turns relinked projects into self-contained bundles that play on any machine
with no sample files present.

## The constraint that shapes everything

`makebundle` **copies** files. It does not **find** them.

LMMS resolves each sample path, copies whatever sits at that location into a
`resources` folder, and rewrites the reference to `local:resources/<name>`. A
path that does not resolve just produces a bundle with a missing resource.
Nothing errors loudly. The result looks self-contained and plays silence.

That is why the pipeline is gated:

```
1. Resolve      relink paths, or recreate the original directory
2. VERIFY       every reference must resolve on disk, exact case
3. Bundle       lmms makebundle
4. Dedupe       ours — LMMS copies once per reference, not per file
5. Validate     prove the bundle is actually self-contained
```

**Stage 2 is the point.** Skipping it converts a loud failure into a quiet one.
It has already earned its place: during development the gig-folder samples were
temporarily absent, and the gate blocked the bundle instead of producing 44
silent projects.

## Verified LMMS behaviour

Established by running LMMS 1.3.0-alpha.1.1024 on macOS, not assumed. These
correct the original spec:

| Spec said | Actually |
|---|---|
| `lmms --makeBundle <in> <out>` | `lmms makebundle <in> [out]` — an **action**, lowercase, not a flag |
| May need `.mmp` input | **`.mmpz` works directly**; no decompress step needed |
| Output folder named after the project | Named after the **output argument**: `<out>/<basename(out)>.mmpz` |

Also confirmed:

- Bundled references use the `local:resources/<name>` prefix.
- LMMS refuses to write where a `resources` folder already exists. Clearing a
  previous bundle is an explicit `--overwrite`, never a silent delete.
- In the Drumline projects only `audiofileprocessor` nodes carry `src`.

## The duplication problem

LMMS copies once per **reference**, not per unique file. Measured on a real
project:

| | Before | After dedupe |
|---|---|---|
| Resource files | 18 | **3** |
| Size | 29.27 MB | **4.54 MB** |

Three samples referenced eighteen times shipped as eighteen byte-identical
copies (`Bass Drum Sounds.wav`, `-1` … `-7`). Across 44 snapshots that is
roughly 1.3 GB of duplicate audio.

### How dedupe works

1. Hash every file in the bundle's `resources` folder (SHA-256).
2. Group by **content**, never by filename — two different files that happen to
   share a name are never merged.
3. Pick a canonical name per group, preferring the one without LMMS's `-N`
   counter.
4. Rewrite the project's references, matching the **full attribute value**
   including its closing quote, so `Snare.wav` can never partially match
   `Snare-1.wav`.
5. Write the project (round-trip verified through `compressMmpz`) **before**
   deleting any resource.
6. Delete the redundant copies.

### Rules that keep snapshots independent

- Dedupe happens **within a single bundle only**.
- Resources are **never shared between bundles**. Each interim carries its own
  complete set.
- **No symlinks.** They cannot hold repaired content, break when the bundle is
  moved or zipped, and need elevated privileges on Windows.

Every snapshot therefore remains independently playable on its own.

## Two silent failures LMMS will hand you

Both exit **0** and look like success. Both are detected before bundling.

### 1. Empty sample slots

An `audiofileprocessor` with `src=""` — an instrument with no sample loaded,
common in early snapshots. LMMS logs:

```
QFile::copy: Empty or null file name
ERROR: Failed to copy resource
"Failed to copy resources."
```

…then writes **no project file** and exits 0. Three of the 44 Drumline
snapshots hit this.

### 2. Rebundling

Running `makebundle` on a project that already uses `local:` references
produces an empty `resources` folder, **no project file**, and exit 0:

```
ERROR: Failed to copy resource
"Failed to copy resources."
```

**Always bundle from the relinked source, never from a bundle.** The batch
detects `local:` references up front and blocks with a clear reason.

## Linux portability

The likely destination is a Linux machine, and macOS hides a class of bug that
Linux exposes: **macOS is case-insensitive, Linux is case-sensitive.** A
reference to `Snare.wav` when the file is `snare.wav` loads perfectly on the
machine that built the bundle and silently plays nothing on the grader's.

After bundling, `normalizeForLinux()` repairs what it safely can:

| Problem | Fix |
|---|---|
| Backslash in a `local:` reference | converted to `/` |
| Reference case differs from the file on disk | reference rewritten to the real filename |
| Resources colliding case-insensitively | reported, never silently merged |
| Reference still absolute (bundling incomplete) | reported, not guessed at |

References are rewritten rather than files renamed — renaming could collide
with another resource.

`auditLinuxPortability()` then re-checks read-only. Verified on a deliberately
broken bundle: a resource renamed to `snare sounds.WAV` was detected, corrected,
re-audited clean, and the result still loaded and rendered in LMMS.

Also relevant: **relinked (non-bundled) projects do not travel to Linux.** They
carry absolute macOS paths like `/Users/…/samples/gig/…`. Only bundles are
portable.

## Validation

One deliberate change from the spec: it asked that the resource count match the
reference count. After dedupe that is wrong by design. The correct invariant is
that the resource count matches the number of **distinct referenced filenames**,
with nothing orphaned.

Checks performed on each bundle:

- `resources` folder exists and is not empty
- every in-scope `src` carries the `local:` prefix
- every referenced resource exists, case exact
- no orphaned resources

## Usage

```bash
# One project, full pipeline with a readable trace
node tools/bundle-test.js <relinked-project.mmpz> <outputDir>

# Verify a whole snapshot tree without bundling anything
node tools/bundle-batch.js <snapshotDir> <outputDir> --dry-run

# Bundle the tree
node tools/bundle-batch.js <snapshotDir> <outputDir> --overwrite
```

Options: `--no-dedupe` to keep LMMS's raw output, `--lmms <path>` for a
non-standard binary location.

Sample directories can be overridden with `LMMS_USER_SAMPLES`,
`LMMS_FACTORY_SAMPLES`, `LMMS_GIG_DIR`, `LMMS_SF2_DIR`.

### Batch behaviour

- A project that fails verification is **reported and skipped**; the batch never
  aborts.
- `.mmpz.bak` autosaves are excluded — they carry the old paths.
- Each interim bundles from its own resolved state into its own folder.
- One JSON log per run, recording every project, its resolution status, its
  bundle status, and anything skipped with the reason.

## Proof of independence

The deduped bundle was rendered with LMMS after being copied to an unrelated
location:

```
Loading project...
Done
```

7.1 MB of audio, **zero "Sample not found" messages**, and the project contains
no reference to the gig folder at all — only `local:resources/…`.

## Limits

- Requires LMMS 1.3.0-alpha or later. Older builds have no `makebundle` and no
  `local:` prefix; the tool detects this by asking the binary what it supports
  and refuses rather than producing nothing.
- Vestige VST plugins are excluded by LMMS's design. Samples loaded inside a VST
  sampler are not captured in a bundle.
- Bundling shells out to the LMMS binary, so it cannot run in a browser, on a
  phone, or in a cloud environment. Relinking can.
- On headless Linux, `QT_QPA_PLATFORM=offscreen` is set automatically; a virtual
  framebuffer may still be needed on some builds.
