# generate-speech

A script a person's AI runs on the person's own computer. It makes speech from text with a provider command the person names (a hosted voice service's caller or a voice program on the computer) and keeps what the command returns. The voice and the service are the person's choice, never in the code. When there is no text, no provider, or the provider fails or answers without audio, the result is an error that says so; nothing is ever made up.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:generate-speech`: `on-your-computer`, with the command that fetches it and runs it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/generate_speech.py` | The command. Reads the request, runs the provider command, writes any audio returned inline to a file, prints `{"result": ...}`. Exit 0 for a result, 2 for an error. |
| `do-work/local_voice_provider.py` | A provider that needs no account: the voice program already on the computer (`say`, `espeak-ng` or `espeak`, in the order `options.engines` gives), with the voice `options.voice` names, writing a 16-bit WAV. Also the shape a real provider follows. |
| `read-data/speech_records.py` | Pure functions: which of a provider's answers are audio, the `speech-generation.result`, and the errors. |
| `test/generate-speech.test.mjs` | Runs the command on synthetic requests with the local voice provider (using stand-in voice programs) and with providers that fail, are missing, answer with nothing, answer by web address, or read the environment. Skips, saying why, when python3 is missing. |

## How to run it

```
python3 do-work/generate_speech.py --request request.json --out ./speech
```

`request.json`:

```
{ "request_id": "any stable text", "text": "what to say",
  "voice_profile_ref": "the person's own name for the voice (optional)",
  "provider": { "argv": ["program", "--request-json", "{request}", "--output-json", "{output}"],
                "env_names": ["VARIABLE_THE_PROGRAM_READS"], "timeout_seconds": 600 },
  "options": { "voice": "...", "language": "...", "format": "..." }, "requested_at": "when it was asked" }
```

`{request}` and `{output}` in `argv` become the paths of this request's JSON and of the file the provider writes its answer to. The provider sees the request without its `provider` part, and only `PATH`, `HOME`, `LANG` and the variables named in `env_names`, copied from this computer's environment: a key never travels in the request.

The provider's answer is `{"output_artifact_refs": [{"src": "data:audio/wav;base64,...", "media_type": "audio/wav"} | {"url": "..."} | {"path": "..."}], "provider_ref": "...", "language": "...", "format": "audio/wav", "duration_ms": 0, "completed_at": "..."}`. Audio returned as a `data:` address is written to `<folder>/<request_id>-<n>.<extension>` and named by `path`; a `url` or `path` is kept as it is.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `speech-generation.result` | `{ request_id, voice_profile_ref, provider_ref, language, format, duration_ms, output_artifact_refs[{path\|url, media_type, byte_length}], src, completed_at }` | What was made. |
| `speech-generation.error` | `{ request_id, voice_profile_ref, code, message, details?, observed_at }` | Why nothing was made. Codes: `speech_generation_empty_text`, `speech_provider_missing`, `speech_provider_not_found`, `speech_provider_timed_out`, `speech_provider_failed`, `speech_provider_answer_unreadable`, `speech_generation_command_output_missing_artifacts`. |
| `result_payload` | `(request, answer) => result \| error` | The answer read as a result, or the error when it holds no audio. |

## Overlap with other Workshop tools

`tools/media-composition` has `tts-narrate.mjs`, which narrates one line into a 48 kHz stereo WAV for a video's audio lane with `say` or `espeak-ng`. This tool is the general one: any provider the person names (including hosted voice services), the person's own voice name carried through, and a kept result or an honest error. The local voice provider here is the no-account provider of this tool's contract; it does not mix or resample.

## Dependencies

**Depends on:** Python 3.10+ (standard library only) and the person's provider command. Nothing is sent anywhere by this script; what the provider command sends is the person's choice.

**Depended on by:** `tool-rows.json` (`tool:generate-speech`), run on the person's computer by their AI.
