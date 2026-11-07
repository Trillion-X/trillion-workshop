  async function send(body, { idempotent, requestKey = null }) {
    for (let attempt = 0; ; attempt += 1) {
      let response = null, failure = null;
      try { response = await fetchImpl(door.mcp, { method: 'POST', headers, body, signal: signal() }); } catch (error) { failure = error; }
      const later = rules.retry_seconds[attempt];
      const passing = failure || response.status === 429 || response.status >= 500;
      // A call that already waited its whole time is not sent again: the answer is slow, not lost.
      const timedOut = failure?.name === 'TimeoutError';
      if (passing && !timedOut && later !== undefined) { await wait(later * 1000); continue; }
      const maybe = idempotent ? '' : ' It may have happened; read it back before trying again.';
      if (timedOut) {
        const error = new TrillionError(`${door.name} did not answer within ${rules.call_timeout_seconds} seconds.${maybe}`, { status: 4 });
        if (!idempotent && requestKey) error.outcomeUnknown = true;
        throw error;
      }
      if (failure) {
        const error = new TrillionError(fill(rules.words.unreachable, { door: door.name, why: failure.cause?.code ?? failure.message }) + maybe, { status: 4 });
        if (!idempotent && requestKey) error.outcomeUnknown = true;
        throw error;
      }
      if (response.status === 401) throw refused();
      if (response.status === 404) throw new TrillionError(fill(rules.words.missing_route, { door: door.name, route: new URL(door.mcp).pathname }), { status: 4 });
      if (passing || !response.ok) {
        const error = new TrillionError(`${door.name} answered ${response.status}.${maybe}`, { status: 4 });
        if (!idempotent && requestKey && (response.status >= 500 || response.status === 408)) error.outcomeUnknown = true;
        throw error;
      }
      return response;
    }
  }
