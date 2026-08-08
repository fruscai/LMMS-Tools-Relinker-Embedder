# Testing

```bash
npm test
```

37 automated tests, all passing. Fixtures are genuine LMMS output, not
synthesised XML.

## Spec test coverage

| # | Requirement | Status | How |
|---|-------------|--------|-----|
| 1 | Genuine `.mmpz` decompression matches `lmms --dump` | **Passing** | Runs the real LMMS binary and compares SHA-256. Skips automatically if LMMS is not installed. |
| 2 | `.mmp` → our `.mmpz` → our decompression returns the original bytes | **Passing** | Byte-exact assertion, plus a Unicode variant. |
| 3 | Generated `.mmpz` opens in LMMS | **Passing** | See below. |
| 4 | LMMS-compressed vs our-compressed XML identical | **Passing** | Plus byte-identity measured and documented. |
| 5 | Single path changes, nothing else | **Passing** | Asserts the surrounding document is untouched. |
| 6 | All occurrences replaced | **Passing** | Against a real project; `factorysample:` counts unchanged. |
| 7 | No match leaves the project unchanged | **Passing** | SHA-256 equality. |
| 8 | Corrupt `.mmpz` rejected, nothing written | **Passing** | Also asserts no output file is produced. |
| 9 | Unicode, accents, spaces | **Passing** | Fixture with `Ünïcode`, `Échantillons`, `日本語`. |
| 10 | Several hundred nested projects | **Passing** | 300 projects, end-to-end, every output verified. |

## TEST 1 — verified against real LMMS

```
our decompression  sha256: bd42936c4fa698565d47e52232b15c3a0d4374b51111ef4d0e2febd512228179
lmms -d (minus trailing \n): bd42936c4fa698565d47e52232b15c3a0d4374b51111ef4d0e2febd512228179
```

`lmms -d` appends one trailing newline that is not part of the stored bytes.

## TEST 3 — verified, not assumed

The specification says not to claim completion until a generated `.mmpz` has
actually been opened by LMMS. It has been.

```bash
node tests/interop-test3.js          # produces a repaired .mmpz
```

Then, against the produced file:

1. **LMMS parses it.** `lmms -d` on our output succeeds, and the XML LMMS
   recovers is SHA-256 identical to the bytes we intended to store — so LMMS's
   own `qUncompress` agrees with our container byte for byte.
2. **LMMS fully loads and renders it.** A headless render completed:

```
PERFLOG | Project Render | 17.07user, 10.28system 8.86elapsed
Loading project...
Done
```

producing a 44 MB WAV. The render log shows
`Sample not found: C:/Users/NewUser/Documents/lmms/samples/gigs/...`, which is
the intended result — LMMS is now looking in the **new** location.

## TEST 4 — byte-identity finding

Twelve genuine LMMS projects, decompressed and recompressed:

```
12 files: round-trip OK 12/12, byte-identical to LMMS output 12/12
```

Byte-identical on this toolchain (Node zlib 1.2.12 vs Qt `qCompress`). Recorded
as information; the enforced contract is round-trip correctness, not byte
equality.

## Beyond the specified tests

- Scan is proven read-only: every source file is hashed before and after.
- Repair is proven non-destructive: source tree hashed before and after.
- ZIP-slip, absolute paths, drive letters and symlink entries are refused.
- Decompression bombs rejected via declared-size and output-length limits.
- Output paths cannot escape the destination folder.
- Reports contain no audio data.
- Length-delta guard: any unexpected change in document size rejects the file.

## Manual end-to-end rehearsal

```bash
node tests/e2e-zip.js
```

Builds an archive shaped like a real bundle (differently-named folders, nested
projects, Unicode folder names, unrelated files), runs the exact pipeline the
GUI runs, and verifies the rebuilt archive. Result:

```
scan: 13 projects (6 .mmp, 7 .mmpz), 12 contain the path, 156 references, 1 needs no changes
repair: 12 modified, 156 replacements, 0 validation failures
verified 12 repaired projects, hierarchy and extras intact
source archive untouched: true
ALL E2E CHECKS PASSED
```

## Inspection tools

```bash
node tools/list-paths.js <folder|zip|project>              # what roots are actually stored
node tools/scan-cli.js <source> <oldPath> [newPath]        # read-only scan
```

`list-paths.js` reports only what is present. It does not guess, match
filenames, or search the filesystem.
