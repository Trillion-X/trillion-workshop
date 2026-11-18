# tools/keep-each-accounts-setup-access-request-in-a-book/

The one-book-per-request keeping is now `workflow:keep-each-accounts-setup-access-request-in-a-book` (`tools/workflows/recipes/keep-each-accounts-setup-access-request-in-a-book.json`, kit beside it). Its proof is in the lane that landed it (commit 9aebe8023).

The held old Trillion files (`from-an-older-version/src/setup-access-records.mjs.held` and its test) were removed here: nothing imported them, and they are kept at tag `old-trillion-before-worker-retire` under their old paths, named in `moved-from.json`.
