# XMEML export adapter

`exportXmeml({title, edl, sourceMetadata})` returns `{xml, support}`. It is a
pure translation of the existing composition schema, with no filesystem writes,
media processing or editor activation. The caller writes XML beside the existing
editable composition JSON and saves `support` with the export/job.

Pass the **complete EDL after adding music, color and captions**, not only its
spine. `edl.encode` supplies real width, height and fps. `audio_graph.music_bed`
supplies the music artifact and trim. `sourceMetadata` is keyed by absolute source
path; actual probes can supply `fps`, `duration`, `width`, `height`, `has_audio`
and `sample_rate`. Missing source fps is explicitly reported as an assumption.
Never manufacture probe values or mark editor import verified.

Sources are named as the editor's computer names them: a POSIX path (Mac, Linux),
written as `file:///Volumes/dav/...`, or a Windows drive path such as a mapped
network drive, written as `file://localhost/Z:/...`. Trillion's account tool
`tool:send-edit-to-editor` (src/editor-handoff.mjs) names each clip where the
person's files appear once their `/dav/` folder is connected.

Expansion integration replaces `premiereSequence(title, segments)` with this
function at the existing timeline-write site. Persist `support` in both rendering
and completed job records so later UI can explain the handoff accurately. Source
JSON remains the complete editable composition; this adapter neither burns in
transforms nor claims XMEML reproduces them.

Retained: ordered source in/out cuts, cumulative sequence timing, integer and
nominal NTSC frame rates, sequence dimensions, linked source-audio references and
an independently editable trimmed music track, independently placed audio, and
their scalar volume. Source files get stable shared
references, and silent sources do not shift audio link indexes.

Limitations are machine-readable: color and framing transforms, caption styles,
music fades/ducking/padding, visual-layer transforms and unknown render fields are
not translated. Multichannel audio routing needs editor verification. Unsupported
retiming/repeated cuts reject rather than changing downstream timeline duration.
The output explicitly says `editor_import_verified: false`.

Image overlays with resolved `image_path` export as separate still-image clips.
Their start/end times are quantized to sequence frames and clipped at the sequence
end. Repeated images reuse one file reference. Image tracks precede added video
tracks, matching the renderer's compositing order. `stillframe` is written on
the clipitem, as permitted by Apple's version-5 interchange DTD. Image geometry,
opacity and effects remain explicitly untranslated; native import is unverified.

Music and added-audio `volume` values use the XMEML `Audio Levels` effect with
`effectid=audiolevels`, audio media type, and parameter `level`. Apple's archived
[XMEML documentation](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Topics/Topics.html)
defines Level as **linear gain**, not decibels. Zero remains exactly zero rather
than falling through to a default or being converted to negative infinity.
Absent/null music volume defaults to 0.9 and added-audio volume to 1, matching
the composition renderer's defaults. Nonfinite, negative and nonnumeric values
reject export. Source-clip audio does not inherit music or placement gain.
Unknown placement effects remain listed as untranslatable; scalar gain does not
claim equivalent ducking, fades, channel routing or native editor playback.

Validation: `node --test do-work/__tests__/export-xmeml.test.mjs`. Tests parse the
actual XML with Python ElementTree and check source-vs-sequence timing, fractional
frame accumulation, source references, audio indexes, music trim, support limits
and hostile input, plus actual parsed audio effect identities, fractional gain,
unity, default levels and exact mute. No Premiere, Resolve or Final Cut import
has been performed.
