"""Measures graphic layers against a person in a rendered vertical video, and against platform safe zones.

The modules: layers (reads an alpha video or a mask video as per-frame boolean masks), people (person and face masks of
the clean picture, from detection), measure (the per-frame numbers, the law verdicts), free (the free regions a renderer
can place a graphic in), verdicts (writes one clip_quality_verdicts row per check).
"""
