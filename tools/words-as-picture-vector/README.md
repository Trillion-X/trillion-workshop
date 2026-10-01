# tools/words-as-picture-vector/

Turns words into the vector a CLIP picture model gives pictures that show them, so a search for "tennis" can be compared with the picture vectors kept for a person's recordings: the Workshop tool `tool:words-as-picture-vector`, run in a container.

## Files

| File | Purpose |
|------|---------|
| `do-work/words-as-picture-vector.py` | The tool's command: one JSON request on standard input (`texts`, optional `model_folder`), one JSON answer out (`model`, `dims`, `vectors`, each unit length). |
| `part.json` | No public files: only the container runs this code. |
| `tool-rows.json` | The Workshop row Trillion reads for this folder: `tool:words-as-picture-vector`. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| Request | `{ "texts": ["tennis", ...], "model_folder"?: "/opt/models/clip-vit-base-patch32" }` | Words to turn into vectors. |
| Answer | `{ "model": { "name", "pretrained" }, "dims": 512, "vectors": [[...]] }` | One unit-length vector per text, named by the model that made it. |

## Invariants

- The model folder holds `text_model.onnx`, `tokenizer.json` and `model.json` of one CLIP model; the answer names that model, so a caller compares only vectors made by the same model.
- Texts are cut to the model's 77 tokens.

## Dependencies

**Depends on:** Python 3 with `numpy` and `onnxruntime` in the container, and a CLIP text model folder.

**Depended on by:** Trillion's search, which runs `tool:words-as-picture-vector` to compare words with what is seen in a person's recordings.
