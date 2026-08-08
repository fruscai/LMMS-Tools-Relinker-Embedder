# LMMS Path Relinker — web build

A single self-contained HTML file. Send it to anyone; they double-click it and
it works. No install, no Node, no LMMS required, and no server.

**File:** `lmms-path-relinker.html`

## Browser support

| Browser | Status |
|---------|--------|
| **Chrome, Brave, Edge, Opera** (Chromium) | **Recommended** |
| Safari 16.4+ | Works |
| Firefox 113+ | Works |
| Internet Explorer, older Safari/Firefox | Not supported |

Chromium browsers are the best choice: they handle large archives and the
folder picker most reliably. The page needs the browser's built-in
`CompressionStream` / `DecompressionStream`, which is what produces the zlib
stream the `.mmpz` format uses. If those are missing, the page says so on load
rather than producing a broken project.

Everything runs locally. The page makes **no network requests of any kind** —
it works with your machine disconnected.

## Using it

1. Open the HTML file.
2. Drop a ZIP, a folder, or individual `.mmp` / `.mmpz` files.
3. Enter the incorrect path and the replacement path.
4. **Scan** — read-only, shows exactly what will change.
5. **Repair & download** — you get a `_RELINKED.zip` containing the repaired
   projects, every unrelated file preserved, plus a JSON and CSV log.

Your original files are never touched; the browser cannot write back to them.

## Verified behaviour

Tested in-browser against genuine LMMS project files:

- Decompressing a real `.mmpz` yields **SHA-256 `30e0894b…`, identical to the
  Node/desktop build** and to `lmms -d`.
- A pasted Windows path with backslashes correctly matched all 13 references
  stored with forward slashes.
- Compress → decompress round trip is byte-exact.
- A repaired file produced **by this web page** was opened by LMMS, which
  resolved the relinked sample paths correctly.
- ZIP layer: CRC32 verified, Unicode folder names, nested directories and
  unrelated files all preserved byte-for-byte.

## One difference from the desktop build

The desktop build produces `.mmpz` files that are **byte-identical** to LMMS's
own output, because Node exposes zlib's compression level.

Browsers do not expose that level, so the web build's compressed bytes differ
slightly in size (for example 72,098 vs 72,141 bytes for the same project).

**This does not affect compatibility.** The contract LMMS actually requires is
that `qUncompress` recovers the intended XML, which is verified on every single
file before you receive it. LMMS was confirmed to load `.mmpz` files compressed
at zlib levels 1, 6 and 9, and to load the web build's output directly.

## Limits

- ZIP64 archives (over 4 GB, or more than 65,535 entries) are not supported;
  use a folder instead.
- Very large archives are held in memory, so a multi-gigabyte bundle may be
  slow. Non-project files are copied through in their original compressed form
  rather than being decompressed, which keeps this manageable.
