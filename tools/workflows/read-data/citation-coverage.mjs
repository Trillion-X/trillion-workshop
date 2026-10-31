// Measures exact page × question × engine observations. It preserves the engine's
// original links and only treats the page URL, its checked canonical URL, and
// explicitly verified redirect URLs as the same page.

const httpUrl = value => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A page identity must be a non-empty URL.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid URL: ${value}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`Only public HTTP(S) URLs without embedded credentials are page identities: ${value}`);
  }
  parsed.hash = '';
  return parsed.href;
};

const stringValue = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
};

function pageIdentities(page) {
  if (!page || typeof page !== 'object') throw new Error('Each page must be an object with a url.');
  if (!Array.isArray(page.verified_redirects ?? [])) throw new Error(`verified_redirects for ${page.url} must be an array.`);
  const values = [page.url, ...(page.canonical_url ? [page.canonical_url] : []), ...(page.verified_redirects ?? [])];
  return new Set(values.map(httpUrl));
}

function isPageCitation(page, citation) {
  let identity;
  try { identity = httpUrl(citation); } catch { return false; }
  return page.identities.has(identity);
}

/**
 * Build a complete matrix from a planned set and sparse engine observations.
 * status=observed requires explicit answer text and citations (an empty array
 * means a measured answer with no citations). unavailable/not-run stay unknown.
 */
export function measureCitationCoverage({ pages, questions, engines, observations = [] } = {}) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('pages must be a non-empty array.');
  if (questions !== undefined && (!Array.isArray(questions) || !questions.length)) throw new Error('questions, when supplied, must be a non-empty array.');
  if (!Array.isArray(engines) || !engines.length) throw new Error('engines must be a non-empty array.');
  if (!Array.isArray(observations)) throw new Error('observations must be an array.');

  const plannedPages = pages.map(page => ({ ...page, url: httpUrl(page.url), identities: pageIdentities(page) }));
  const unique = values => new Set(values).size === values.length;
  if (!unique(plannedPages.map(page => page.url))) throw new Error('Each planned page url must be unique.');
  const ownerByIdentity = new Map();
  for (const page of plannedPages) for (const identity of page.identities) {
    const earlier = ownerByIdentity.get(identity);
    if (earlier && earlier !== page.url) throw new Error(`Verified page identity ${identity} belongs to more than one planned page.`);
    ownerByIdentity.set(identity, page.url);
  }
  const questionsByPage = new Map(plannedPages.map((page, pageIndex) => {
    const listed = page.questions ?? questions;
    if (!Array.isArray(listed) || !listed.length) throw new Error(`Page ${page.url} needs questions on the page or in the shared questions list.`);
    const checked = listed.map((question, index) => stringValue(question, `pages[${pageIndex}].questions[${index}]`));
    if (!unique(checked)) throw new Error(`Questions for ${page.url} must be unique.`);
    return [page.url, checked];
  }));
  const plannedQuestions = [...new Set([...questionsByPage.values()].flat())];
  const plannedEngines = engines.map((engine, index) => stringValue(typeof engine === 'string' ? engine : engine?.id, `engines[${index}].id`));
  if (!unique(plannedQuestions)) throw new Error('Each planned question must be unique.');
  if (!unique(plannedEngines)) throw new Error('Each planned engine id must be unique.');

  const pageByInput = new Map(plannedPages.map(page => [page.url, page]));
  const index = new Map();
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') throw new Error('Each observation must be an object.');
    const pageUrl = httpUrl(observation.page_url);
    const question = stringValue(observation.question, 'observation.question');
    const engine = stringValue(observation.engine, 'observation.engine');
    if (!pageByInput.has(pageUrl) || !questionsByPage.get(pageUrl).includes(question) || !plannedEngines.includes(engine)) {
      throw new Error('An observation names a page, question or engine outside the planned matrix.');
    }
    const key = JSON.stringify([pageUrl, question, engine]);
    if (index.has(key)) throw new Error(`Duplicate observation for ${pageUrl} × ${question} × ${engine}.`);
    if (!['observed', 'unavailable', 'not-run'].includes(observation.status)) throw new Error(`Observation status must be observed, unavailable or not-run for ${key}.`);
    if (observation.status === 'observed') {
      if (typeof observation.answer !== 'string' || !Array.isArray(observation.citations) || typeof observation.observed_at !== 'string' || !observation.observed_at) {
        throw new Error(`An observed answer needs answer text, citations (possibly empty), and observed_at for ${key}.`);
      }
      for (const citation of observation.citations) stringValue(citation, `citation for ${key}`);
    }
    index.set(key, observation);
  }

  const cells = [];
  for (const page of plannedPages) for (const question of questionsByPage.get(page.url)) for (const engine of plannedEngines) {
    const key = JSON.stringify([page.url, question, engine]);
    const observation = index.get(key) ?? { status: 'not-run' };
    const known = observation.status === 'observed';
    const cited = known ? observation.citations.some(citation => isPageCitation(page, citation)) : null;
    cells.push({
      cell_id: key,
      page_url: page.url,
      question,
      engine,
      status: observation.status,
      citation: cited,
      ...(known ? {
        observed_at: observation.observed_at,
        locale: observation.locale ?? null,
        mode: observation.mode ?? null,
        source: observation.source ?? null,
        answer: observation.answer,
        citations: [...observation.citations],
      } : {
        reason: observation.reason ?? null,
        locale: observation.locale ?? null,
        mode: observation.mode ?? null,
        source: observation.source ?? null,
      }),
    });
  }
  const known = cells.filter(cell => cell.citation !== null);
  return {
    planned: { pages: plannedPages.length, questions: plannedQuestions.length, engines: plannedEngines.length, cells: cells.length },
    measured: known.length,
    cited: known.filter(cell => cell.citation).length,
    not_cited: known.filter(cell => !cell.citation).length,
    unknown: cells.length - known.length,
    citation_rate: known.length ? known.filter(cell => cell.citation).length / known.length : null,
    cells,
  };
}
