// Generic records-backed feed reader for widgets and other small surfaces.
// Feed sources and row projections are DATA; this code does not name a product feed or record kind.
import defaultData from './glance-feeds.json' with { type: 'json' };

const fail = (code, words) => Object.assign(new Error(words), { code });

function at(value, path) {
  let current = value;
  for (const key of path) {
    if (key === '*') {
      if (!Array.isArray(current)) return undefined;
      current = current.flatMap(item => {
        const found = at(item, path.slice(path.indexOf('*') + 1));
        return found === undefined ? [] : Array.isArray(found) ? found : [found];
      });
      return current;
    }
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function same(left, right) {
  if (left === right) return true;
  if (typeof left === 'number' && typeof right === 'number') return Number.isFinite(left) && Number.isFinite(right) && left === right;
  return false;
}

function passes(row, descriptor) {
  const tests = descriptor.where === undefined ? [] : Array.isArray(descriptor.where) ? descriptor.where : [descriptor.where];
  return tests.every(test => {
    if (!test || !Array.isArray(test.field) || test.field.length === 0) throw fail('bad_feed', 'A feed filter needs a field path.');
    const value = at(row, test.field);
    if (Object.hasOwn(test, 'equals')) return same(value, test.equals);
    if (Object.hasOwn(test, 'none_of')) {
      if (!Array.isArray(test.none_of)) throw fail('bad_feed', 'A none_of filter needs a list.');
      return !test.none_of.some(candidate => same(value, candidate));
    }
    if (Object.hasOwn(test, 'present')) {
      const present = value !== undefined && value !== null && value !== '';
      return present === test.present;
    }
    throw fail('bad_feed', 'A feed filter needs equals, none_of or present.');
  });
}

function ordered(rows, descriptor) {
  const rule = descriptor.order;
  if (rule === undefined) return rows;
  if (!rule || !Array.isArray(rule.field) || !['asc', 'desc'].includes(rule.direction)) throw fail('bad_feed', 'A feed order needs a field path and asc or desc direction.');
  const sign = rule.direction === 'desc' ? -1 : 1;
  return rows.map((row, index) => ({ row, index, key: at(row, rule.field) })).sort((a, b) => {
    if (same(a.key, b.key)) return a.index - b.index;
    if (a.key === undefined || a.key === null) return 1;
    if (b.key === undefined || b.key === null) return -1;
    if (typeof a.key === 'number' && typeof b.key === 'number') return (a.key - b.key) * sign || a.index - b.index;
    return String(a.key).localeCompare(String(b.key), 'en') * sign || a.index - b.index;
  }).map(item => item.row);
}

function shown(row, descriptor) {
  const show = descriptor.show;
  if (!show || typeof show !== 'object') throw fail('bad_feed', 'A feed needs show DATA.');
  const readText = key => {
    const path = show[key];
    if (path === undefined) return undefined;
    if (!Array.isArray(path)) throw fail('bad_feed', `The ${key} field needs a path.`);
    const value = at(row, path);
    if (value === null || value === undefined) return undefined;
    return typeof value === 'string' ? value : String(value);
  };
  const rowId = descriptor.row_id;
  if (rowId !== undefined && (!rowId || (rowId.prefix !== undefined && typeof rowId.prefix !== 'string') || !Array.isArray(rowId.field))) throw fail('bad_feed', 'A row_id needs a field path and optional prefix.');
  const id = rowId ? `${rowId.prefix ?? ''}${String(at(row, rowId.field) ?? '')}` : row.id ?? at(row, ['seq']) ?? '';
  const output = { id: String(id), title: readText('title') ?? '', source: row };
  for (const key of ['detail', 'note', 'open', 'time']) {
    let value = key === 'open' && show.open && !Array.isArray(show.open)
      ? (Array.isArray(show.open.path) ? at(row, show.open.path) : undefined)
      : readText(key);
    if (key === 'open' && value === undefined && typeof show.open?.fill === 'string') {
      value = show.open.fill.replace(/\{([^{}]+)\}/g, (_, path) => {
        const part = at(row, path.split('.'));
        return part === null || part === undefined ? '' : encodeURIComponent(String(part));
      });
    }
    if (typeof value === 'string' && value.length) output[key] = value;
  }
  if (show.flagged !== undefined) {
    if (!Array.isArray(show.flagged)) throw fail('bad_feed', 'The flagged field needs a path.');
    output.flagged = at(row, show.flagged) === true;
  } else output.flagged = false;
  if (show.read !== undefined) {
    if (!Array.isArray(show.read)) throw fail('bad_feed', 'The read field needs a path.');
    const value = at(row, show.read);
    if (typeof value === 'boolean') output.read = value;
  }
  if (show.actions !== undefined) {
    if (!Array.isArray(show.actions)) throw fail('bad_feed', 'The actions field needs a path.');
    const value = at(row, show.actions);
    if (Array.isArray(value)) output.actions = value;
  }
  if (show.done !== undefined || show.total !== undefined) {
    if (!Array.isArray(show.done) || !Array.isArray(show.total)) throw fail('bad_feed', 'Progress needs done and total paths.');
    const done = at(row, show.done), total = at(row, show.total);
    if (typeof done === 'number' && typeof total === 'number' && total > 0) output.fraction = Math.min(1, Math.max(0, done / total));
  }
  return output;
}

function validateSource(source) {
  if (source?.module !== undefined) {
    if (typeof source.module !== 'string' || !/^\.\.?\//.test(source.module)
      || typeof source.export !== 'string' || !source.export || !Array.isArray(source.rows)) {
      throw fail('bad_feed', 'A packaged source needs a relative module, export and rows path.');
    }
    return;
  }
  if (!source || typeof source !== 'object' || typeof source.type !== 'string' || !source.type || !Array.isArray(source.rows)) {
    throw fail('bad_feed', 'A feed read needs a record type and rows path.');
  }
  if (source.prefix !== undefined && (typeof source.prefix !== 'string' || !source.prefix)) throw fail('bad_feed', 'A record source prefix must be nonempty text.');
  if (source.fields !== undefined && (!Array.isArray(source.fields) || source.fields.length > 64 || source.fields.some(field => typeof field !== 'string' || !field))) {
    throw fail('bad_feed', 'A record source fields value must be a list of at most 64 names.');
  }
  if (source.where !== undefined && (!source.where || typeof source.where !== 'object' || Array.isArray(source.where))) throw fail('bad_feed', 'A record source where value must be an object.');
}

async function readRows(feed, door, limits = defaultData.limits) {
  validateSource(feed.read);
  const most = limits?.most_source_records ?? 2000;
  // The source is trusted package DATA, never a caller-selected module. Composing its exported reader keeps
  // record layouts and migration rules with their existing owner instead of duplicating them in each feed.
  if (feed.read.module !== undefined) {
    const source = await import(new URL(feed.read.module, import.meta.url));
    const read = source[feed.read.export];
    if (typeof read !== 'function') throw fail('bad_feed', 'The packaged feed reader is unavailable.');
    const answer = await read(feed.read.input ?? {}, { door });
    const rows = feed.read.rows.length ? at(answer, feed.read.rows) : answer;
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw fail('source_shape', `Feed ${feed.id} reader did not return its declared rows.`);
    }
    if (rows.length > most) throw fail('source_bound', `Feed ${feed.id} exceeds its ${most}-row read bound.`);
    return rows;
  }
  const query = { type: feed.read.type, ...(feed.read.prefix ? { prefix: feed.read.prefix } : {}),
    ...(feed.read.fields ? { fields: feed.read.fields } : {}), ...(feed.read.where ? { where: feed.read.where } : {}) };
  const rows = [];
  let records = 0;
  for await (const record of door.list(query)) {
    records += 1;
    if (records > most) throw fail('source_bound', `Feed ${feed.id} exceeds its ${most}-record read bound.`);
    const found = feed.read.rows.length ? at(record, feed.read.rows) : record;
    if (found === undefined || found === null) throw fail('source_shape', `Feed ${feed.id} record ${record.id} has no rows at its declared path.`);
    if (Array.isArray(found)) rows.push(...found);
    else rows.push(found);
  }
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw fail('source_shape', `Feed ${feed.id} contains a row that is not an object.`);
  return rows;
}

/** Read one feed or a named surface, applying only the source and projection declared in DATA. */
export async function readGlanceFeeds(input = {}, { door, data = defaultData } = {}) {
  if (!door || typeof door.list !== 'function') throw fail('bad_input', 'The records door is required.');
  const hasFeed = typeof input.feed === 'string' && input.feed.length > 0;
  const hasSurface = typeof input.surface === 'string' && input.surface.length > 0;
  if (hasFeed === hasSurface) throw fail('bad_input', 'Name exactly one feed or surface.');
  const feedRows = data.feeds;
  if (!Array.isArray(feedRows)) throw fail('bad_data', 'Feed DATA has no feeds list.');
  let selected;
  let surface;
  if (hasFeed) {
    selected = feedRows.filter(feed => feed.id === input.feed);
    if (!selected.length) throw fail('not_found', `There is no feed ${input.feed}.`);
  } else {
    const ids = data.surfaces?.[input.surface];
    if (!Array.isArray(ids)) throw fail('not_found', `There is no surface ${input.surface}.`);
    surface = input.surface;
    selected = ids.map(id => {
      const feed = feedRows.find(candidate => candidate.id === id);
      if (!feed) throw fail('bad_data', `Surface ${input.surface} names missing feed ${id}.`);
      return feed;
    });
  }
  const limit = input.limit ?? data.limits?.default_rows_per_feed ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > (data.limits?.most_rows_per_feed ?? 200)) throw fail('bad_input', `limit must be a positive whole number up to ${data.limits?.most_rows_per_feed ?? 200}.`);
  const feeds = await Promise.all(selected.map(async feed => {
    if (typeof feed.id !== 'string' || typeof feed.label !== 'string') throw fail('bad_data', 'Every feed needs an id and label.');
    if (typeof feed.unavailable === 'string' && feed.unavailable) {
      return { id: feed.id, label: feed.label, about: feed.about ?? '', status: 'unavailable', error: { code: 'source_unavailable', message: feed.unavailable } };
    }
    try {
      const sourceRows = await readRows(feed, door, data.limits);
      const projected = ordered(sourceRows.filter(row => passes(row, feed)), feed).map(row => shown(row, feed)).filter(row => row.title.length > 0);
      return { id: feed.id, label: feed.label, about: feed.about ?? '', empty: feed.empty ?? 'Nothing here yet.', status: 'ready', rows: projected.slice(0, limit) };
    } catch (error) {
      return { id: feed.id, label: feed.label, about: feed.about ?? '', status: 'unavailable', error: {
        code: typeof error?.code === 'string' ? error.code : 'source_unavailable',
        message: error instanceof Error ? error.message : 'The feed source is unavailable.',
      } };
    }
  }));
  return { ...(surface ? { surface } : {}), feeds };
}
