# generate-speech

A script a person's AI runs on the person's own computer. It makes speech from text with a provider command the person names (a hosted voice service's caller or a voice program on the computer) and keeps what the command returns. The voice and the service are the person's choice, never in the code. When there is no text, no provider, or the provider fails or answers without audio, the result is an error that says so; nothing is ever made up.

It also says words in the person's chosen natural voice with a speech model on their computer (`tool:say-with-a-voice-model`) and keeps their voices as rows of their Voices list (`tool:voices`), both `computer` rows run by the engine. Moved from the product repo's `computer/speak.mjs` and `computer/speak-with-mlx.py`.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | `tool:generate-speech`: `on-your-computer`, with the command that fetches it and runs it. `tool:say-with-a-voice-model` and `tool:voices`: `computer` rows with no capability yet (see Not yet), rights to the person's Voices and Where Trillion speaks lists and their rows, and to their files under `/Voice`. |
| `read-data/speak.mjs` | `say` and `voices`, run as functions by `tools/records-door`: the voice order (asked, else the place's or the chosen voice, else the shared voices), the voice and speed of a place, saying into the run's folder and keeping the sound in the person's files, and making, choosing and removing voices as list rows. |
| `read-data/speak.json` | The speech programs and engines, the shared voices, the Voices and Where Trillion speaks list definitions, the speed scale, loudness, how a reference is picked, where a sound is kept, and every word. |
| `do-work/speak-with-mlx.py` | The speech program: says a request with mlx-audio (`say`) or picks a reference stretch from a recording with mlx-whisper's word times (`reference`), once per request. |
| `test/speak.test.mjs` | The voice order, strict voices, passing over a voice that cannot be made, no voice at all, a kept sound with the place's speed, and making, choosing and removing voices, on a stub model and an in-memory door (the product repo's `test/speak.test.mjs`, its assertions kept). |
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

## Not yet

- The speech program cannot start in a `computer` run yet. It is a Python that has mlx-audio, numpy and soundfile, outside `/bin` and `/usr/bin`, and no capability starts it: trillion-rust `src/runtime/workshop/computer-capabilities.json` `programs` has `ai-command`, `headless-browser` and `record-and-hear`. It needs a program row such as `{"id": "speak-with-a-model", "parameters": {"program": "program", "models": "folder"}, "sandbox": ["(allow process-exec* file-read* (literal \"{program}\"))", "(allow file-read* (subpath \"{program_folder}\"))", "(allow file-read* (subpath \"{models}\"))", "(allow iokit-open (iokit-user-client-class \"AGXDeviceUserClient\"))", "(allow mach-lookup (global-name \"com.apple.MTLCompilerService\"))"]}`: the program, the environment it lives in, the downloaded models folder (read-only; the models are fetched once beforehand) and the Apple GPU through Metal. The exact Metal rules are unmeasured. Until then the rows declare no capability, and `tool:voices` lists, chooses and removes voices while `say` and `make` answer the program's refusal.
- Each run starts the model fresh: the product repo kept one resident speaker per computer on a socket under the person's home, which a run's own folder cannot hold past the run.
- No sound is played: the sound is a file in the person's files, so no audio output device is needed.
- The Mac app's road (say a notice into a local file, and tell the person's AI work once when a notice could never be said) stays with the product repo's Mac app.

## Overlap with other Workshop tools

`tools/media-composition` has `tts-narrate.mjs`, which narrates one line into a 48 kHz stereo WAV for a video's audio lane with `say` or `espeak-ng`. This tool is the general one: any provider the person names (including hosted voice services), the person's own voice name carried through, and a kept result or an honest error. The local voice provider here is the no-account provider of this tool's contract; it does not mix or resample.

## Dependencies

**Depends on:** Python 3.10+ (standard library only) and the person's provider command; for the computer rows, `tools/records-door` (`read-data/lists-door.mjs`, `read-data/whole-file.mjs`, `do-work/run-an-export.mjs`) and a Python with mlx-audio, numpy, soundfile and mlx-whisper on an Apple silicon Mac. Nothing is sent anywhere by this script; what the provider command sends is the person's choice.

**Depended on by:** `tool-rows.json` (`tool:generate-speech`, `tool:say-with-a-voice-model`, `tool:voices`).
