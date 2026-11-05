"""Pulls recent posts from the forums a person names through the Arctic Shift public Reddit archive (free, no key).

tool:keep-forum-posts-from-a-public-archive. usage: fetch_forum_posts.py < request.json
The request: {"forums": {forum: group} or [forum or {"name", "group"}], "pages": 6, "progress": {...}, "budget_seconds": 100}.
`group` is the person's own word for who writes in a forum (it was the icp_segment); it is kept on each post line.
Each output line of out/forum-posts.jsonl is the archive's own fields we keep:
forum, group, id, permalink, title, selftext, score, num_comments, created_utc.
Questions are chosen later by tools/collect-and-rank-viewer-questions; nothing is invented here.
The archive is a third-party service: this depends on it staying up. A forum whose pages could not be read is named in
`failed`. A run that reaches budget_seconds answers `again`, the request to send next, holding where each forum stopped.
The last line printed is {"result": ...}, or {"error": words saying what to fix}.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

API = "https://arctic-shift.photon-reddit.com/api/posts/search"
KEEP = ("id", "permalink", "title", "selftext", "score", "num_comments", "created_utc")
NAME = re.compile(r"^[A-Za-z0-9_]{2,32}$")
PAGES_AT_MOST = 20
FORUMS_AT_MOST = 100
BUDGET = {"default": 100, "most": 110}
WAIT = float(os.environ.get("FORUM_POSTS_WAIT_SECONDS", "0.5"))


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
            time.sleep(WAIT * 6 * (attempt + 1))
    return None


class Refused(ValueError):
    pass


def read_request(request):
    """The request, checked whole before any page is asked for: forums in order, each with its group."""
    if not isinstance(request, dict):
        raise Refused("Send an object: {\"forums\": {forum: group}, \"pages\": 6}.")
    unknown = sorted(set(request) - {"forums", "pages", "progress", "budget_seconds"})
    if unknown:
        raise Refused(f"Unknown input: {', '.join(unknown)}.")
    given = request.get("forums")
    if isinstance(given, dict):
        given = [{"name": name, "group": group} for name, group in given.items()]
    if not isinstance(given, list) or not 1 <= len(given) <= FORUMS_AT_MOST:
        raise Refused(f"forums is 1 to {FORUMS_AT_MOST} forums: {{forum: group}}, or a list of names or {{name, group}}.")
    sources = {}
    for forum in given:
        forum = {"name": forum} if isinstance(forum, str) else forum
        if not isinstance(forum, dict) or not NAME.match(str(forum.get("name", ""))):
            raise Refused("A forum is its name (letters, digits and _, without r/) or {name, group}.")
        sources[forum["name"]] = forum.get("group")
    pages = request.get("pages", 6)
    if not isinstance(pages, int) or not 1 <= pages <= PAGES_AT_MOST:
        raise Refused(f"pages is a whole number from 1 to {PAGES_AT_MOST}.")
    budget = request.get("budget_seconds", BUDGET["default"])
    if not isinstance(budget, (int, float)) or not 1 <= budget <= BUDGET["most"]:
        raise Refused(f"budget_seconds is from 1 to {BUDGET['most']}.")
    progress = request.get("progress") or {}
    if not isinstance(progress, dict):
        raise Refused("progress is {forum: {before, pages}}, as again gives it.")
    return sources, pages, budget, progress


def main():
    try:
        sources, pages, budget, progress = read_request(json.loads(sys.stdin.read() or "{}"))
    except (Refused, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(2)
    ends = time.monotonic() + budget
    os.makedirs("out", exist_ok=True)
    forums, failed, left = [], [], {}
    with open("out/forum-posts.jsonl", "a") as out:
        for subreddit, segment in sources.items():
            before = (progress.get(subreddit) or {}).get("before")
            done = (progress.get(subreddit) or {}).get("pages", 0)
            total = 0
            for _ in range(done, pages):
                if time.monotonic() >= ends:
                    left[subreddit] = {"before": before, "pages": done}
                    break
                posts = page(subreddit, before)
                if posts is None:
                    failed.append({"forum": subreddit, "reason": "the archive did not answer after 4 tries"})
                    break
                if not posts:
                    break
                for post in posts:
                    row = {key: post.get(key) for key in KEEP}
                    row["forum"] = subreddit
                    row["group"] = segment
                    out.write(json.dumps(row) + "\n")
                total += len(posts)
                done += 1
                before = min(post["created_utc"] for post in posts)
                time.sleep(WAIT)
            print(subreddit, total, file=sys.stderr)
            forums.append({"forum": subreddit, "posts": total, "pages": done, "finished": subreddit not in left})
    again = None
    if left:
        again = {"forums": {name: sources[name] for name in sources if name in left}, "pages": pages, "progress": left}
    print(json.dumps({"result": {"stopped": "budget" if left else "finished", "forums": forums, "failed": failed, "again": again}}))


main()
