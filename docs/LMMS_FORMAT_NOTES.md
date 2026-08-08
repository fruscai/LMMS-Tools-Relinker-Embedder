# LMMS project format notes

Everything here was verified against LMMS source and against genuine project
files on a real machine. Where a source and observed behaviour disagreed, the
observed behaviour of current LMMS wins, and the difference is noted.

Verification environment: LMMS 1.3.0-alpha (macOS, `/Applications/LMMS.app`),
Node 26.5.0 with zlib 1.2.12.

---

## 1. The two project containers

| Extension | Contents |
|-----------|----------|
| `.mmp`    | Plain-text XML, UTF-8, no BOM |
| `.mmpz`   | The same XML inside a Qt `qCompress` container |

## 2. How LMMS writes a `.mmpz`

From `src/core/DataFile.cpp` in current LMMS:

```cpp
const QString extension = fullName.section('.', -1);
if (extension == "mmpz" || extension == "xptz")
{
    QString xml;
    QTextStream ts( &xml );
    write( ts );
    outfile.write( qCompress( xml.toUtf8() ) );
}
```

Two things follow directly:

- The payload is the XML encoded as **UTF-8**, with no BOM and no extra framing.
- `qCompress` is called **without a level argument**, so it uses Qt's default of
  `-1`, which delegates to zlib's own default compression level.

## 3. How LMMS reads a project

Also from `DataFile.cpp`:

```cpp
if (!lmms::setContent(*this, _data, &errorMsg, &line, &col))
{
    QByteArray uncompressed = qUncompress( _data );
    if( !uncompressed.isEmpty() )
    {
        if (lmms::setContent(*this, uncompressed, &errorMsg, &line, &col))
        ...
```

Worth noting: **LMMS does not dispatch on the file extension or on magic bytes
when reading.** It tries to parse the bytes as XML, and only if that fails does
it try `qUncompress`. So the compatibility requirement for anything we write is
simply that `qUncompress` recovers the intended XML.

## 4. The `qCompress` container

```
[ 4-byte unsigned big-endian uncompressed length ][ zlib stream ]
```

- The prefix is the length of the *uncompressed* data, big-endian.
- The remainder is an ordinary **zlib** stream (RFC 1950), **not gzip** and not
  a ZIP archive. A gzip stream would start `1f 8b`; a `.mmpz` starts `78 9c`.
- `qCompress` of empty input returns four zero bytes and nothing else.

Confirmed on a real file:

```
$ xxd -l 16 "Toccata And Fugue in D Minor.mmpz"
00000000: 0006 8401 789c ecbd 5973 1bc9 d1ef 7d7f
          ^^^^^^^^^ ^^^^
          427009    zlib header (CMF 0x78, FLG 0x9c = default compression)
```

Inflating the tail produced exactly 427009 bytes, matching the declared length.

## 5. Byte-identity with Qt `qCompress`

The specification asked whether the Node implementation emits byte-identical
output to Qt. It was tested, not assumed.

Twelve genuine LMMS-produced `.mmpz` files were decompressed and recompressed
with `zlib.deflateSync(payload, { level: Z_DEFAULT_COMPRESSION })`:

```
12 files: round-trip OK 12/12, byte-identical to LMMS output 12/12
```

**Result: byte-identical on this toolchain.** This makes sense — Qt's
`qCompress` calls zlib's `compress2` with level `-1`, and Node's default
`deflateSync` uses the same level, window bits (15), memory level (8) and
strategy.

This is **documented but not required**. Different zlib builds may legitimately
produce different compressed bytes for identical input. The real compatibility
contract, which the code enforces on every file it writes, is:

```
qUncompress(producedMmpz) === intendedXmlBytes
```

## 6. How sample paths actually appear in project XML

This was researched against real projects rather than assumed, and it produced
the single most important finding in this project.

Sample references live in `src` attributes:

```xml
<audiofileprocessor src="C:/Users/Administrator/Desktop/Production for Racing Game [assets]/kick.wav" .../>
```

### LMMS stores Windows paths with FORWARD slashes

Even for Windows projects, paths are stored as `C:/Users/...`, not
`C:\Users\...`. Qt normalises separators internally.

This matters enormously in practice. A Windows user copying the broken folder
out of LMMS's "sample not found" report will naturally supply a backslash path.
A strictly literal search for that string finds **zero** occurrences, even
though the project is full of the very path they pasted.

The tool therefore also matches the separator-swapped form. This is a labelled,
switchable option, it is never applied silently, and the preview reports which
textual form actually matched. When it matches a swapped form, the replacement
root is written using that same separator convention, so a repaired path never
mixes `/` and `\`.

Verified end to end: a user pasting
`C:\Users\Administrator\Desktop\future_garage_original\`
correctly relinked all 13 references stored as
`C:/Users/Administrator/Desktop/future_garage_original/`.

### LMMS-managed prefixes

Not every `src` value is an absolute path. These are resolved by LMMS itself and
must be left alone:

| Prefix            | Meaning |
|-------------------|---------|
| `factorysample:`  | Ships with LMMS |
| `usersample:`     | Relative to the user's sample directory |
| `usergig:`        | Relative to the user's GIG directory |
| `usersoundfont:`  | Relative to the user's SoundFont directory |

The tool never touches these, because it only ever replaces the exact root the
user supplied.

### XML entity encoding

Attribute values are escaped by Qt's DOM writer (`&` → `&amp;`, `<` → `&lt;`,
`>` → `&gt;`, `"` → `&quot;`). None of the real projects surveyed contained
entities in paths, but a path containing `&` would. The tool matches the escaped
form as well and re-escapes the replacement to match, so it never
double-escapes and never HTML-escapes the wider document.

## 7. Why the document is never re-serialised

The tool decodes the XML to text, performs the narrowest possible substring
replacement, and re-encodes. It never builds a DOM and never writes XML back
out, so whitespace, indentation, attribute order, entity encoding and line
endings are all preserved exactly.

Two guards back this up on every file:

1. Decoded text is re-encoded and compared against the source bytes before any
   edit. If the file is not valid UTF-8 it is refused rather than corrupted.
2. After replacement, the change in document length must equal
   `occurrences × (newRoot.length − oldRoot.length)` exactly. Any other delta
   means something unintended moved, and the file is rejected.

## 8. `lmms -d` adds a trailing newline

`lmms -d project.mmpz` emits the project XML followed by **one extra `\n`** that
is not part of the stored bytes. Comparing our output against a dump must
account for it. With that single byte accounted for, our decompression is
SHA-256 identical to the LMMS dump.
