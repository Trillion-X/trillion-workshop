# generate-images

A script a person's AI runs on the person's own computer. It makes images from a prompt with a provider command the person names (a hosted model's caller or a local model's program) and keeps what the command returns. The provider and the model are the person's choice, never in the code. When there is no provider, or the provider fails or answers without an image, the result is an error that says so; nothing is ever made up.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:generate-images`: `on-your-computer`, with the command that fetches it and runs it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/generate_images.py` | The command. Reads the request, runs the provider command, writes any image returned inline to a file, prints `{"result": ...}`. Exit 0 for a result, 2 for an error. |
| `do-work/placeholder_image_provider.py` | The smallest provider: one solid-colour PNG per prompt, no account, no model. For checking the chain and as the shape a real provider follows. |
| `read-data/image_records.py` | Pure functions: which of a provider's answers are images, the `image-generation.result`, and the errors. |
| `test/generate-images.test.mjs` | Runs the command on synthetic requests with the placeholder provider and with providers that fail, are missing, answer with nothing, answer by web address, or read the environment. Skips, saying why, when python3 is missing. |

## How to run it

```
python3 do-work/generate_images.py --request request.json --out ./images
```

`request.json`:

```
{ "request_id": "any stable text", "prompt": "what the picture should show",
  "provider": { "argv": ["program", "--request-json", "{request}", "--output-json", "{output}"],
                "env_names": ["VARIABLE_THE_PROGRAM_READS"], "timeout_seconds": 600 },
  "options": {}, "requested_at": "when it was asked" }
```

`{request}` and `{output}` in `argv` become the paths of this request's JSON and of the file the provider writes its answer to. The provider sees only `PATH`, `HOME`, `LANG` and the variables named in `env_names`, copied from this computer's environment: a key never travels in the request.

The provider's answer is `{"output_artifact_refs": [{"src": "data:image/png;base64,...", "media_type": "image/png"} | {"url": "..."} | {"path": "..."}], "provider_ref": "...", "format": "image/png", "completed_at": "..."}`. An image returned as a `data:` address is written to `<folder>/<request_id>-<n>.<extension>` and named by `path`; a `url` or `path` is kept as it is.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `image-generation.result` | `{ request_id, prompt, provider_ref, format, output_artifact_refs[{path\|url, media_type, byte_length}], src, completed_at }` | What was made. |
| `image-generation.error` | `{ request_id, prompt, code, message, details?, observed_at }` | Why nothing was made. Codes: `image_provider_missing`, `image_provider_not_found`, `image_provider_timed_out`, `image_provider_failed`, `image_provider_answer_unreadable`, `image_generation_command_output_missing_artifacts`. |
| `result_payload` | `(request, answer) => result \| error` | The answer read as a result, or the error when it holds no image. |

## Overlap with other Workshop tools

`tools/tools-from-github` lists other people's image programs as tools to install; none of them is a provider command this script runs, and none keeps a result or an honest error. `tools/media-composition` makes video from pictures and does not make pictures.

## Dependencies

**Depends on:** Python 3.10+ (standard library only) and the person's provider command. Nothing is sent anywhere by this script; what the provider command sends is the person's choice.

**Depended on by:** `tool-rows.json` (`tool:generate-images`), run on the person's computer by their AI.
