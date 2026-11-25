// tools/publish-articles/do-work/serve.ts
//
// The one main of this tool's reads: node serve.ts <reader name>, with the request on stdin and the pursuit database's
// connection on descriptor 3 (run-sql-in-my-database/do-work/serve-a-read.ts owns that road).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveARead } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';
import { readArticle, readArticleList } from './articles.ts';
import { readFeed } from './rss.ts';
import { planConfirm, planSignup } from './signup.ts';

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  await serveARead({ readArticleList, readArticle, readFeed, planSignup, planConfirm });
}
