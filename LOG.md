# Daily Log

## 08-27-2026

Single file input and less UI

- A single `.mmpz` or `.mmp` can now be dropped or picked directly. Before this the smallest
  input was a folder or a ZIP
- The scope step is gone. Every project in the source gets embedded, and one final project is one
  dropped file
- The samples step lost its number and its explanation. Gig folder line first, then a sample
  folder button, with one line: only needed when a sample is not in the gig folder
- Source errors show under the dropzone instead of next to the run buttons

Escaped sample names

- BIG ONE: **sample names come out of the raw XML still escaped.** A project referencing
  `R&B Piano 83BPM.wav` holds `usergig:R&amp;B Piano 83BPM.wav` in `src`, and the lookup matched
  that escaped form against the filename on disk. Found nothing, reported the sample missing,
  wrote the project back unchanged. Any name with `&` in it hit this. The embedder now unescapes
  entities before matching
- Measured on the failing project after the fix: 11 of 11 references embedded, and the output
  renders in stock 1.3 identical to the file-based version, 12241665 frames, peak 26027

A clip is a copy

- A sample used by eleven clips is written eleven times, because a clip reads only its own `data`
  attribute (SampleClip.cpp) and the format has no way for one clip to point at another's buffer.
  An 8.2 MB wav across eleven clips is 229 MB of XML, 108 MB compressed. Renders in 17 seconds

SlicerT

- `slicert` added to the covered elements. Stock 1.3 SlicerT reads `sampledata`
  (SlicerT.cpp line 363), and the embedder skipped those projects with no error

The size cap

- The 300 MB cap is gone. The check now sits at 500 MB of text, under the V8 string limit of
  about 536 M characters, which is the point past which the output cannot exist as one string in
  any Chromium browser or Node. The error names the heaviest sample and points at the native
  `lmms embedsamples` command, which has no such limit

Samples only

- The embed path no longer strips `midicontrollers` nodes or relabels the header. Version
  compatibility is a separate problem from embedding and the two were tangled in one pass
- 1.2.2 measured anyway: the embedded project renders there too, mean within 0.07% of the
  file-based version. The drumsynth tracks are silent in BOTH, because 1.2 reads the
  `factorysample:` prefix a 1.3 save writes as a literal filename. Not an embedding effect

Checked across project shapes, all through the real code path in the browser, all rendered with
stock 1.3 against file-based baselines

- three samples in one project, referenced as `usergig:`, a Windows path and a bare relative
  path: frames and peak identical, mean within 0.08%
- a reference that exists nowhere: kept its `src`, named in the report, the other ten embedded
- uncompressed `.mmp` input: same result as `.mmpz`
- no user path survives in any output. The only `src` left is `factorysample:`, which a stock
  install resolves


## 08-10-2026

Audio formats

- The embedder only read WAV, because I wrote the decoder by hand. Replaced the whole thing with
  `AudioContext.decodeAudioData`, which reads every format the browser supports, so MP3, OGG,
  FLAC and AIFF all embed now. Tested by embedding an MP3 into a project whose references were all
  `.wav` names, which works because matching is by filename and the decoder does not care what the
  container actually is
- ⚠️ The sample rate finding, which I had wrong earlier. I tested embedding with 44.1 kHz sources,
  saw the render come out identical to the file-based version, and concluded rate did not matter.
  That was only true because the sources happened to already be at 44.1. A 48 kHz sample embedded
  raw renders at **202 Hz against the correct 220 Hz**, which is the 48000/44100 ratio flat.
  Embedded audio carries no rate of its own, so LMMS reads the frames as though they are already at
  the engine rate
- The fix comes free with `decodeAudioData`, because creating the context at 44100 makes it
  resample anything to 44.1 on the way in. A 22 kHz, a 48 kHz and a 96 kHz source of the same
  quarter-second tone all come out at 11,024 frames. After that the 48 kHz source renders at
  220 Hz, matching file-based exactly

BIG ONE: LMMS 1.2 will not play embedded audio, and it is a bug in LMMS

- Installed 1.2.2 alongside 1.3 to check the grader's environment properly. The delivered embedded
  final renders **silent** in 1.2.2, peak 0, while the same project with file-based samples renders
  at peak 32,767. Same install, so it is not a broken build
- The cause is in `audio_file_processor.cpp` on `stable-1.2`:

      else if( _this.attribute( "sampledata" ) != "" )
      {
          m_sampleBuffer.loadFromBase64( _this.attribute( "srcdata" ) );
      }

  It checks `sampledata` and then reads `srcdata`, which does not exist, so it loads an empty
  string and plays nothing. No error, no warning, just silence
- Writing the same base64 into BOTH attributes fixes it. 1.2 reads `srcdata`, 1.3 reads
  `sampledata` and ignores the other. Measured after the change: 1.2.2 peak 32,767, 1.3 peak 28,834
- The cost is that the audio is stored twice, so files roughly double. Acceptable because embedding
  is only used on the final project

The midicontrollers modal

- The grader also reported a "Plugin not found: midicontrollers" modal once per track in 1.2. The
  final has 18 of those nodes, one per instrument track, each with 128 attributes that are all
  zero. They arrive when a project passes through 1.3 once, which also stamps the header
  `creatorversion="1.3.0-alpha"`
- The body underneath is still 1.2-shaped, `pattern` and `fxmixer` and `automationpattern`, so this
  is a 1.2 project wearing a 1.3 label rather than a real format upgrade. Stripping the nodes and
  reverting the header makes it genuinely 1.2 again, and 1.2.2 then loads it with zero complaints
- The header only gets reverted when the body has no 1.3-only elements. A project that genuinely
  contains `midiclip` or `mixer` cannot open in 1.2 whatever the header says, so relabelling it
  would only make the failure worse and more confusing

Colours

- Repainted all three tools onto the LMMS palette, charcoal shell with the green it uses for clips
  and the purple it uses for automation. The blue, green and purple accents still separate the
  three tools from each other, they just come from LMMS now rather than being invented

## 08-09-2026

Sample Embedder

- The sample embedder builds upon the previous dependency issues which could not be solved by
  replacement into the gig folder or by using bundle mode. LMMS `.mmpz` uses base64 for file
  embedding and is typically used for smaller references, but it can be co-opted to carry the
  audio data itself, which removes the external file dependency entirely rather than pointing it
  somewhere else
- Built it as a single standalone HTML file rather than another Electron app. Embedding is only
  data work — decompressing the project, decoding the WAV into frames, base64, rewriting the XML
  and recompressing — and browsers now do every one of those natively through `CompressionStream`
  and `DecompressionStream`. Bundling is the opposite case, because it shells out to the LMMS
  binary, which is why that one has to remain a desktop application
- The scope choice matters for how it gets used. Embedding everything makes every snapshot and
  autosave in the folder self-contained, which is what I want when the whole set gets submitted.
  Embedding one project is for when the interims should stay as normal relinked projects and only
  the final one needs to survive being sent elsewhere. Either way every other file in the folder is
  copied through without being touched

Relinker + Embedder

- Built a second HTML file that runs both stages in one pass, because relinking and embedding
  answer different questions and I need both in the normal workflow. Stage A rewrites the paths so
  the projects open on my own machine and I can actually work on them. Stage B takes one chosen
  project and embeds it, which is the copy that goes out. The output folder is named for whichever
  stages actually ran, so `-RELINKED-EMBEDDED` means both happened and I don't have to remember

⚠️ The `usergig:` prefix bug

- `path.basename("usergig:Snare Sounds.wav")` returns the entire string including the prefix,
  because there is no slash after the colon for it to split on. The lookup was therefore searching
  for a file literally named `usergig:Snare Sounds.wav`, never finding it, and leaving the
  reference alone
- The result was that `Drumline_Orchestration_Final_V2`, which is the one project that actually
  matters, came out of the run with ZERO samples embedded while every other project embedded fine
- The run reported 86 files written and 0 failed, so from the outside it looked like a complete
  success. The only thing that caught it was the `MISSING samples: 18` counter in the summary,
  which is the reason that counter exists at all. A tool that reports "0 failed" while shipping a
  broken final project is worse than one that crashes, because you ship it

Fixtures

- Replaced the test fixtures before making the repo public. They were a real project of mine, which
  is fine locally and not fine published. The replacement is a generated project with the same
  structure and the music stripped out
- The generated XML still gets compressed by LMMS itself rather than by our own code, because the
  `lmms -d` comparison and the byte-identity test only mean something if the fixture is genuinely
  LMMS output. A fixture I compressed myself would only be testing our code against itself

## 08-08-2026

makebundle

- Built the bundle pipeline around `lmms makebundle`, but ran the real binary first rather than
  writing to the spec, which corrected three assumptions. It is `lmms makebundle <in> [out]`, an
  action rather than a `--makeBundle` flag, and lowercase. It accepts `.mmpz` input directly so
  there is no need to decompress to `.mmp` first. The project it writes is named after the output
  argument rather than after the source project, which matters when you are scripting it and
  looking for the file afterwards
- LMMS copies a sample once per REFERENCE rather than once per unique file. A project using three
  samples across eighteen instruments therefore ships eighteen separate copies, and 4.5 MB of audio
  came out as a 29 MB bundle. Added a dedupe step that hashes the resources with SHA-256, groups by
  content, keeps one copy per group and rewrites the references to point at it. Across all 44
  projects that took 1,174 MB down to 182 MB
- The dedupe deliberately stays inside a single bundle. Sharing one resources folder across all the
  bundles would have taken it down to about 5 MB, but every interim snapshot then depends on that
  shared folder existing, and the entire point was that each one plays independently

Linux

- macOS is case-insensitive by default and Linux is not, so a reference to `Snare.wav` when the
  file on disk is actually `snare.wav` loads perfectly on the machine that built the bundle and
  produces nothing on the grader's. This is the kind of failure that never shows up locally
- Wrote a normalisation pass for it that rewrites the reference to match the real filename rather
  than renaming the file, since renaming could collide with another resource. Tested it by breaking
  a bundle on purpose, renaming a resource to `snare sounds.WAV`, and confirming it was detected,
  corrected, re-audited clean and still rendered

⚠️ Two ways makebundle fails while reporting success

- An `audiofileprocessor` with `src=""`, meaning an instrument that was added but never had a
  sample loaded into it, makes makebundle print `QFile::copy: Empty or null file name`, write no
  project file at all, and still exit 0. Three of the 44 snapshots had this
- Running makebundle on a project that already uses `local:` references does the same thing, giving
  an empty resources folder and no project file while exiting 0. So bundling always has to run from
  the relinked source and never from an existing bundle
- Both of these look identical to success from outside the process. Anything scripting makebundle
  has to check that the output file exists rather than trusting the exit code

BIG ONE: embedding instead of bundling

- Bundles depend on `local:`, which only exists from LMMS 1.3.0-alpha onward while 1.2.2 is still
  the last stable release, and they depend on the folder structure surviving the trip. Neither of
  those is something I can guarantee on a machine I don't control
- Reading the LMMS source for `AudioFileProcessor` showed that the loader checks `src` first and
  only falls back to a base64 `sampledata` attribute when `src` is absent. Putting the audio into
  `sampledata` therefore leaves nothing to resolve at all, which sidesteps the version requirement,
  the folder structure and the working directory in one move
- **`src` wins over `sampledata`**, so the attribute has to be removed rather than blanked. If it
  is left in place pointing at a file that doesn't exist, LMMS reports the missing file and ignores
  the embedded audio completely, which is exactly the failure being fixed
- Proved it by rendering from `/` with no sample files anywhere on the machine, and the audio came
  out byte-identical to the bundle version
- The sample rate looked like a problem, since the base64 carries no rate metadata and
  `fromBase64` defaults to the engine's output rate. Tested it rather than assuming, and embedded
  and file-based renders are byte-identical at both 44.1 kHz and 48 kHz, so the concern was
  unfounded and no resampling was needed
- Embedded all 44 snapshots along with the 42 `.mmpz.bak` autosaves, which came to 1,445 samples
  embedded with none missing

⚠️ Bare relative paths appear to work and do not

- Tried `src="Snare Sounds.wav"` with the WAV sitting beside the project, which would have been the
  simplest possible fix and needed no version support. It rendered perfectly with audio identical
  to the bundle, so it looked like the answer
- Then ran the same project from `/` instead of from its own folder and got complete silence, peak
  amplitude 0, with LMMS reporting every sample missing. Relative paths resolve against the working
  directory rather than against the project file, and only `local:` is anchored to the project
- This would have shipped if the second render had been run from the same folder as the first

## 08-06-2026

The format

- `.mmpz` is Qt's `qCompress` container, which is a four-byte big-endian uncompressed length
  followed by a plain zlib stream. It is not gzip and not a ZIP archive, and the four-byte prefix
  is why treating it as either fails immediately. Confirmed on real project files rather than
  taking the forum answers at face value
- Our decompression is SHA-256 identical to what `lmms -d` produces, with the only difference being
  a single trailing newline the CLI adds that is not part of the stored bytes
- Our compression came out byte-identical to LMMS's own output across twelve real projects, because
  Node's default zlib level matches the default that Qt's `qCompress` passes through. That is
  stronger than needed, since the actual requirement is only that `qUncompress` returns the right
  XML, but it is worth knowing

BIG ONE: LMMS stores Windows paths with forward slashes

- A project that broke on `C:\Users\...\Audio Files\` is stored in the XML as
  `C:/Users/.../Audio Files/`, because Qt normalises the separators when the path is saved
- This means pasting the broken path straight out of the LMMS error dialog, which is the obvious
  thing any user would do, matches nothing at all. The tool would report zero occurrences on a
  project that is full of the exact path that was pasted
- Handled by matching both separator directions and writing the replacement back in whichever
  direction the file actually uses, with the matched form shown in the preview so nothing happens
  invisibly

Build

- Built the compression layer first and the interface last, on the basis that the format is the
  part which can silently corrupt work while an interface bug is obvious. 45 tests, all against
  real LMMS fixtures rather than XML written to match our own assumptions
- Built the Electron app first and then a single-file HTML version, and the HTML one is what
  actually gets used, since it needs no install, works offline and can be sent to someone as one
  file
- Did not treat it as finished until a generated `.mmpz` had been opened by LMMS and rendered to a
  44 MB WAV, because everything up to that point was only testing our code against itself

⚠️ Traps

- Nearly built this by parsing the XML into a DOM, changing the paths and writing it back out,
  which is the obvious approach. That would have reformatted whitespace, reordered attributes and
  re-encoded entities across every project touched, and none of it would have been visible for
  months. It is now a narrow text replacement with a length-delta check that rejects the file if
  anything other than the requested root moved
- `[hidden]` in HTML loses to any class that sets a `display` value, so panels that were supposed
  to be closed stayed on screen until `[hidden]{display:none!important}` was added
- Leaving the replacement path empty made the scan preview stripping the root off every path and
  reducing them to bare filenames, which looked like a working preview. Both fields are required
  now
