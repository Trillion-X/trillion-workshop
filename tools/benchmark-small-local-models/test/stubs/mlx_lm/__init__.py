"""Stand-in mlx-lm: answers a numbered list with the number of the first candidate sharing a word with the text above
the list, and anything else with how many words the message holds."""
import re
import types

from stand_in_words import shared


class Tokenizer:
    def apply_chat_template(self, messages, add_generation_prompt=True, tokenize=False, enable_thinking=False):
        return messages[0]["content"]


def load(name):
    return object(), Tokenizer()


def generate(model, tok, prompt=None, max_tokens=None, verbose=None):
    numbered = re.findall(r"^(\d+)\. (.*)$", prompt, re.M)
    if numbered:
        text = prompt.split("\n")[0]
        return next((n for n, option in numbered if shared(text, option)), "99")
    return str(len(prompt.split()))
