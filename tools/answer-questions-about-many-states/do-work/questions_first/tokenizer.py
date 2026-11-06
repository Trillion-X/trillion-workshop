"""The model folder's own tokenizer (tokenizer.json), read with the `tokenizers` library, with no special tokens added:
what transformers' fast tokenizer gives for encode(text, add_special_tokens=False)."""
import json, os


class FolderTokenizer:
    def __init__(self, tk):
        self.tk = tk

    def encode(self, text, add_special_tokens=False):
        return self.tk.encode(text, add_special_tokens=False).ids


def load_tokenizer(model_dir):
    """-> (tokenizer, pad id). The pad id only fills right padding after the last slot, which no slot reads."""
    from tokenizers import Tokenizer
    path = os.path.join(model_dir, "tokenizer.json")
    if not os.path.exists(path):
        raise FileNotFoundError(f"no tokenizer.json in {model_dir}")
    tk = Tokenizer.from_file(path)
    pad = None
    cfg = os.path.join(model_dir, "tokenizer_config.json")
    if os.path.exists(cfg):
        c = json.load(open(cfg))
        name = c.get("pad_token")
        name = name.get("content") if isinstance(name, dict) else name
        pad = tk.token_to_id(name) if name else None
    if pad is None:
        pad = 0
    return FolderTokenizer(tk), pad
