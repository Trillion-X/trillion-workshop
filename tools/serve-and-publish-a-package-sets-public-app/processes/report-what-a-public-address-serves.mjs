// Report what a public address actually serves, in words.
//
// WHY THIS EXISTS. Deploying reports that a deployment happened, and a log says
// what a process intended. Neither answers the only question that matters to
// somebody waiting for a page: does opening this address give a person
// something. That question was being answered by reading start-up lines and
// inferring, which is how a machine that boots, installs, opens and then serves
// nothing reads as success.
//
// It names no app, no provider and no product. It is handed an address and it
// says what came back: the status, what kind of thing it is, how big it is, and
// the opening of it, so a page of real markup and a one-line error page cannot
// look the same in the report.
//
// IT ALSO SAYS WHICH LAYER ANSWERED, and that was the missing half. Two
// addresses answering 200 with HTML look identical here even when one was
// rendered by the public server and the other was passed through to whatever
// sits behind it. Body text cannot tell those apart, because the pass-through
// answer is a real document too. The answer carries it already: `Server-Timing`
// names the branch that produced the response, and its ABSENCE is the finding,
// because it means nothing in the public server rendered this at all. Reported
// as `answered_by`, alongside the small set of headers that say whether an
// answer is a fresh render, a cached copy, or a redirect that was followed.
import process from 'node:process';

const address = process.argv[2];
if (!address || !/^https?:\/\//.test(address)) {
  console.error('report-what-a-public-address-serves <https://address> [path ...]');
  process.exit(2);
}
const paths = process.argv.length > 3 ? process.argv.slice(3) : ['/'];
// A machine that has just started can take a while to answer, and a timeout
// reads exactly like a refusal if nothing says which happened.
const waitMilliseconds = Number(process.env.SERVE_REPORT_WAIT_MS ?? 20000);

let allServed = true;
for (const path of paths) {
  const url = new URL(path, address).toString();
  const started = Date.now();
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(waitMilliseconds),
    });
    const body = await response.text();
    const opening = body.slice(0, 160).replace(/\s+/g, ' ').trim();
    const timing = response.headers.get('server-timing');
    console.log(JSON.stringify({
      url,
      status: response.status,
      kind: response.headers.get('content-type'),
      characters: body.length,
      milliseconds: Date.now() - started,
      // Absent means no part of the public server claimed this answer, which is
      // a different fault from a wrong page and is invisible in the body.
      answered_by: timing ?? 'nothing named itself',
      arrived_at: response.url === url ? undefined : response.url,
      opening,
    }, null, 2));
    if (!response.ok || body.length === 0) allServed = false;
  } catch (error) {
    console.log(JSON.stringify({
      url,
      nothing_came_back: String(error && error.message ? error.message : error),
      milliseconds: Date.now() - started,
    }, null, 2));
    allServed = false;
  }
}
process.exit(allServed ? 0 : 1);
