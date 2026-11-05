"""Pulls recent posts from the ICP's subreddits through the Arctic Shift public Reddit archive (free, no key).

usage: fetch_reddit.py <sources.json> <out.jsonl> [pages]
sources.json maps subreddit -> icp_segment. Each output line is the archive's own fields we keep:
subreddit, icp_segment, id, permalink, title, selftext, score, num_comments, created_utc.
Questions are chosen later by select_questions.py; nothing is invented here.
"""
import json
import sys
import time
import urllib.parse
import urllib.request

API = "https://arctic-shift.photon-reddit.com/api/posts/search"
KEEP = ("id", "permalink", "title", "selftext", "score", "num_comments", "created_utc")


def page(subreddit, before):
    query = {"subreddit": subreddit, "limit": "100", "sort": "desc"}
    if before:
        query["before"] = str(before)
    url = API + "?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(url, headers={"User-Agent": "viewer-question-research/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)["data"]
        except Exception as error:
            print("retry", subreddit, attempt, error, file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    return []


def main():
    sources = json.load(open(sys.argv[1]))
    pages = int(sys.argv[3]) if len(sys.argv) > 3 else 6
    with open(sys.argv[2], "a") as out:
        for subreddit, segment in sources.items():
            before = None
            total = 0
            for _ in range(pages):
                posts = page(subreddit, before)
                if not posts:
                    break
                for post in posts:
                    row = {key: post.get(key) for key in KEEP}
                    row["subreddit"] = subreddit
                    row["icp_segment"] = segment
                    out.write(json.dumps(row) + "\n")
                total += len(posts)
                before = min(post["created_utc"] for post in posts)
                time.sleep(0.5)
            print(subreddit, total, file=sys.stderr)


main()
