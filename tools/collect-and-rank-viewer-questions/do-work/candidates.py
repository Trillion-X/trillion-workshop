"""Pulls real question candidates out of the raw sources and writes them as a TSV for reading.

usage: candidates.py <viewer-questions-dir> <out.tsv> [<extra-comments-dir> <videos.tsv>]
Sources read under <dir>: forum posts (post titles and question sentences in post bodies) from forum-posts.jsonl, as
tool:keep-forum-posts-from-a-public-archive keeps them (each with its `group`), or raw/reddit.jsonl (each with its
`icp_segment`); video comments (question sentences in top comments) from youtube-comments/*.info.json or
raw/youtube-comments/*.info.json (yt-dlp --write-comments), and from comments.jsonl as
tool:keep-channels-latest-videos-and-captions keeps them ({video_id, comments} a line). With <extra-comments-dir> and
<videos.tsv> (a header line, then the watch link in the third column), the info.json files there of those videos too. A candidate is one sentence that ends in "?",
has 6 to 40 words, and is written by the asker (first person or a direct how/why/what question). Text is kept
verbatim; nothing is rewritten or invented. Columns: id, source_kind, source_url, icp_segment, score, question.
The last line printed is {"result": {candidates, posts, videos, out}}.
"""
import glob
import json
import os
import re
import sys

WATCH = "https://www.youtube.com/watch?v="

SENTENCE = re.compile(r"[^.!?\n]*\?")
FIRST_PERSON = re.compile(r"\b(i|i'm|i've|i'd|my|me|we|our|am i|do i|should i|can i|how do i|how can i)\b", re.I)
WH = re.compile(r"^(how|why|what|which|is|are|do|does|can|should|would|will|am|where|when|who)\b", re.I)
JUNK = re.compile(r"https?://|\[removed\]|\[deleted\]|@\w+|nsfw|\bporn\b|\bsex\b|\bkill myself\b|\bsuicid", re.I)


def sentences(text):
    for match in SENTENCE.finditer(text or ""):
        sentence = re.sub(r"\s+", " ", match.group(0)).strip(" \"'*_>-")
        words = sentence.split()
        if 6 <= len(words) <= 40 and not JUNK.search(sentence) and (FIRST_PERSON.search(sentence) or WH.match(sentence)):
            yield sentence


def main():
    root = sys.argv[1]
    seen = set()
    rows = []

    def add(kind, url, segment, score, sentence):
        key = re.sub(r"\W+", "", sentence.lower())
        if key in seen:
            return
        seen.add(key)
        rows.append((kind, url, segment, score, sentence))

    posts = [path for path in (root + "/forum-posts.jsonl", root + "/raw/reddit.jsonl") if os.path.exists(path)]
    read_posts = 0
    for line in (line for path in posts for line in open(path) if line.strip()):
        post = json.loads(line)
        post["icp_segment"] = post.get("icp_segment", post.get("group"))
        read_posts += 1
        url = "https://www.reddit.com" + (post["permalink"] or "")
        for sentence in sentences(post["title"] if (post["title"] or "").rstrip().endswith("?") else ""):
            add("reddit-title", url, post["icp_segment"], post["score"] or 0, sentence)
        for sentence in sentences(post["selftext"]):
            add("reddit-body", url, post["icp_segment"], post["score"] or 0, sentence)

    extra = []
    if len(sys.argv) > 4:
        wanted = {line.split("\t")[2].strip().split("v=")[-1] for line in list(open(sys.argv[4]))[1:]}
        extra = [p for p in glob.glob(sys.argv[3] + "/*.info.json") if p.split("/")[-1].removesuffix(".info.json") in wanted]
    infos = [json.load(open(path)) for path in sorted(glob.glob(root + "/youtube-comments/*.info.json"))
             + glob.glob(root + "/raw/youtube-comments/*.info.json") + sorted(extra)]
    if os.path.exists(root + "/comments.jsonl"):
        for line in open(root + "/comments.jsonl"):
            if line.strip():
                video = json.loads(line)
                infos.append({"id": video["video_id"], "webpage_url": WATCH + video["video_id"], "comments": video.get("comments")})
    for info in infos:
        for comment in info.get("comments") or []:
            url = info["webpage_url"] + "&lc=" + comment["id"]
            for sentence in sentences(comment["text"]):
                add("youtube-comment", url, "from-video:" + info["id"], comment.get("like_count") or 0, sentence)

    with open(sys.argv[2], "w") as out:
        for index, (kind, url, segment, score, sentence) in enumerate(rows):
            out.write(f"{index}\t{kind}\t{url}\t{segment}\t{score}\t{sentence}\n")
    print(len(rows), "candidates", file=sys.stderr)
    print(json.dumps({"result": {"candidates": len(rows), "posts": read_posts, "videos": len(infos), "out": sys.argv[2]}}))


main()
