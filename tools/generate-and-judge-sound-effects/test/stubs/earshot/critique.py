"""Stand-in earshot.critique: the critique as one line of words."""


def critique_text(crit):
    return f"stand-in critique: {crit['verdict']} {crit['in_range']}/{crit['scored']}"
