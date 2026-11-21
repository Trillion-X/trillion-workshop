// tools/read-a-page-in-arc/page-scripts.mjs
//
// PURPOSE
//   The JavaScript that runs inside the page in Arc, one small piece per call. Each builder returns the source of one call.
//   Every call's value is a JSON text made of ASCII only (asciiJson), so a string survives Arc's return intact, including
//   characters outside ASCII that Arc would otherwise split. Every number and string the page code uses is written in as a
//   JSON literal, never spliced in as code.
//
//   The in-page code only reads the page and scrolls it. It fills no form, clicks nothing and starts no page script of its own.
//   The download builder fetches a file with the person's sign-in and keeps its bytes in the page until they are read in pieces.

/** JSON text of a value with every character outside ASCII written as a \u escape. This function's source is sent into the page. */
export function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function readyStateScript() {
  return `${asciiJson.toString()};
asciiJson(document.readyState);`;
}

/**
 * One scroll step. Without a selector the window is scrolled to its end (lazy content loads as it is reached). With a selector
 * the pane it names is scrolled one viewport further down, and the text visible in it is merged into the page's kept lines:
 * a list that drops the rows above the viewport (a virtualized pane such as Notion's) still gives its whole text.
 */
export function scrollStepScript(selector) {
  return `${asciiJson.toString()};
(function (selector) {
  var state = window.__arcScroll || (window.__arcScroll = { lines: [], top: null });
  if (!selector) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    return asciiJson({ height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), found: true, atEnd: true });
  }
  var box = document.querySelector(selector);
  if (!box) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    return asciiJson({ height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), found: false, atEnd: true });
  }
  if (state.top === null) {
    box.scrollTop = 0;
  } else {
    box.scrollTop = box.scrollTop + Math.max(1, Math.round(box.clientHeight * 0.8));
  }
  var incoming = (box.innerText || '').split('\\n').map(function (line) { return line.replace(/\\s+$/, ''); });
  var overlap = 0;
  for (var n = Math.min(state.lines.length, incoming.length); n > 0 && overlap === 0; n--) {
    var same = true;
    for (var i = 0; i < n; i++) {
      if (state.lines[state.lines.length - n + i] !== incoming[i]) { same = false; break; }
    }
    if (same) overlap = n;
  }
  for (var j = overlap; j < incoming.length; j++) state.lines.push(incoming[j]);
  state.top = box.scrollTop;
  return asciiJson({ height: box.scrollHeight, found: true, atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 1 });
})(${JSON.stringify(selector ?? null)});`;
}

/**
 * Keeps the page's text (up to maxChars) in the page, and answers its title, address and whole text length. The text is the
 * lines a pane scroll merged, when there are any, and otherwise the body's visible text.
 */
export function stashPageScript(maxChars) {
  return `${asciiJson.toString()};
(function (maxChars) {
  var scrolled = window.__arcScroll;
  var text = scrolled && scrolled.lines.length ? scrolled.lines.join('\\n') : (document.body ? document.body.innerText : '');
  window.__arcPull = { text: text.slice(0, maxChars) };
  return asciiJson({ title: document.title, url: location.href, textChars: text.length });
})(${JSON.stringify(maxChars)});`;
}

/** One piece of the kept text, from start up to end. */
export function textPieceScript(start, end) {
  return `${asciiJson.toString()};
asciiJson(window.__arcPull.text.slice(${JSON.stringify(start)}, ${JSON.stringify(end)}));`;
}

/** Every link of the page that is http or https, deduplicated without its fragment, bounded to maxLinks. */
export function linksScript(maxLinks, maxTextChars) {
  return `${asciiJson.toString()};
(function (maxLinks, maxTextChars) {
  var seen = {}, links = [], found = 0;
  var anchors = document.querySelectorAll('a[href]');
  for (var i = 0; i < anchors.length; i++) {
    var anchor = anchors[i], url;
    try {
      url = new URL(anchor.href, location.href);
    } catch (error) {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    var href = url.href;
    if (seen[href]) continue;
    seen[href] = true;
    found++;
    if (links.length < maxLinks) {
      var text = anchor.innerText || anchor.getAttribute('aria-label') || anchor.title || '';
      links.push({ href: href, text: text.replace(/\\s+/g, ' ').trim().slice(0, maxTextChars) });
    }
  }
  return asciiJson({ links: links, found: found });
})(${JSON.stringify(maxLinks)}, ${JSON.stringify(maxTextChars)});`;
}

/** Starts fetching a file with the page's sign-in. The bytes are kept in the page as base64 once the fetch finishes. */
export function startDownloadScript(address, maxBytes) {
  return `${asciiJson.toString()};
(function (address, maxBytes) {
  window.__arcDownload = { state: 'running' };
  fetch(address, { credentials: 'include' }).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var mediaType = response.headers.get('content-type') || '';
    return response.arrayBuffer().then(function (buffer) { return { buffer: buffer, mediaType: mediaType }; });
  }).then(function (got) {
    if (got.buffer.byteLength > maxBytes) throw new Error('the file is bigger than ' + maxBytes + ' bytes');
    var bytes = new Uint8Array(got.buffer), pieces = [];
    for (var i = 0; i < bytes.length; i += 32768) pieces.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)));
    window.__arcDownload = { state: 'done', mediaType: got.mediaType, bytes: bytes.length, base64: btoa(pieces.join('')) };
  }).catch(function (error) {
    window.__arcDownload = { state: 'failed', error: String((error && error.message) || error) };
  });
  return asciiJson({ state: 'running' });
})(${JSON.stringify(address)}, ${JSON.stringify(maxBytes)});`;
}

/** The state of the fetch started by startDownloadScript, with the length of its base64 text. */
export function downloadStateScript() {
  return `${asciiJson.toString()};
(function () {
  var download = window.__arcDownload;
  if (!download) return asciiJson({ state: 'missing' });
  return asciiJson({
    state: download.state,
    error: download.error || null,
    mediaType: download.mediaType || null,
    bytes: download.bytes || 0,
    base64Chars: download.base64 ? download.base64.length : 0
  });
})();`;
}

/** One piece of the downloaded file's base64 text, from start up to end. */
export function base64PieceScript(start, end) {
  return `${asciiJson.toString()};
asciiJson(window.__arcDownload.base64.slice(${JSON.stringify(start)}, ${JSON.stringify(end)}));`;
}

/**
 * Reads a Notion page through its own API, inside the signed-in tab, without clicking anything: every block of the page in
 * order (any block type: its rich text in any property, its children, table rows, synced blocks, database rows), child pages
 * listed as links. Children the page did not load are fetched with syncRecordValuesSpace. The text goes to window.__arcPull (the
 * place the page text piece reads), the state to window.__arcNotion. Every bound comes from config (pull-settings.json notion).
 */
function readNotion(config) {
  var result = window.__arcNotion = { state: 'running' };
  var origin = location.origin;
  var match = location.pathname.match(/([0-9a-f]{32})\/?$/i);
  if (!match) {
    result.state = 'failed';
    result.error = 'The address has no Notion page id.';
    return;
  }
  var raw = match[1].toLowerCase();
  var pageId = raw.slice(0, 8) + '-' + raw.slice(8, 12) + '-' + raw.slice(12, 16) + '-' + raw.slice(16, 20) + '-' + raw.slice(20);
  var blocks = {};
  var collections = {};
  var chunk = 0;
  var rounds = 0;
  function post(path, body) {
    return fetch(origin + path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + path);
        return response.json();
      });
  }
  function unwrap(entry) {
    return entry && entry.value && entry.value.value ? entry.value.value : (entry && entry.value);
  }
  function absorb(recordMap) {
    var found = (recordMap && recordMap.block) || {};
    Object.keys(found).forEach(function (id) {
      var value = unwrap(found[id]);
      if (value && value.type !== undefined && value.alive !== false) blocks[id] = value;
    });
    var collectionFound = (recordMap && recordMap.collection) || {};
    Object.keys(collectionFound).forEach(function (id) {
      var value = unwrap(collectionFound[id]);
      if (value) collections[id] = value;
    });
  }
  function nextChunk(cursor) {
    return post('/api/v3/loadPageChunk', { page: { id: pageId }, limit: 100, cursor: cursor, chunkNumber: chunk, verticalColumns: false })
      .then(function (data) {
        absorb(data.recordMap);
        chunk += 1;
        var more = data.cursor && data.cursor.stack && data.cursor.stack.length > 0;
        if (more && chunk < config.maxChunks) return nextChunk(data.cursor);
      });
  }
  function childIdsOf(value) {
    var ids = (value.content || []).slice();
    var pointer = value.format && value.format.transclusion_reference_pointer;
    if (pointer && pointer.id) ids.push(pointer.id);
    return ids;
  }
  function missingIds() {
    var missing = {};
    Object.keys(blocks).forEach(function (id) {
      childIdsOf(blocks[id]).forEach(function (child) { if (!blocks[child]) missing[child] = true; });
    });
    return Object.keys(missing);
  }
  function syncRound() {
    var ids = missingIds();
    if (!ids.length || rounds >= config.maxRounds) return Promise.resolve();
    rounds += 1;
    var requests = ids.slice(0, 100).map(function (id) { return { pointer: { table: 'block', id: id }, version: -1 }; });
    return post('/api/v3/syncRecordValuesSpace', { requests: requests }).then(function (data) {
      absorb(data.recordMap);
      return syncRound();
    });
  }
  // Rich text: the pieces of one property as plain text. A mention shows the title of the page it names; an equation shows its expression.
  function richText(pieces) {
    return (pieces || []).map(function (piece) {
      var decorations = piece[1] || [];
      if (piece[0] === '\u2023') {
        var page = decorations.filter(function (d) { return d[0] === 'p'; })[0];
        var target = page && blocks[page[1]];
        return target ? richText((target.properties || {}).title) : '';
      }
      var equation = decorations.filter(function (d) { return d[0] === 'e'; })[0];
      if (piece[0] === '\u204d' && equation) return equation[1];
      return piece[0] || '';
    }).join('');
  }
  var SKIP = { checked: 1, language: 1, source: 1, link: 1, format: 1, color: 1, display_source: 1, width: 1 };
  // Every property of a block that holds text, in the order the block stores them: title first, then caption and the rest.
  function textOf(value) {
    var properties = value.properties || {};
    var names = Object.keys(properties).filter(function (name) { return !SKIP[name]; });
    names.sort(function (a, b) { return a === 'title' ? -1 : b === 'title' ? 1 : 0; });
    return names.map(function (name) { return richText(properties[name]); }).filter(function (text) { return text !== ''; }).join(' ');
  }
  function propertyText(value, name) {
    return richText((value.properties || {})[name]);
  }
  var lines = [];
  var links = [];
  var linkSeen = {};
  var visited = 0;
  function addLink(href, text) {
    if (!href || linkSeen[href]) return;
    linkSeen[href] = true;
    links.push({ href: href, text: text });
  }
  function push(depth, line) {
    if (line !== null && line !== undefined && line !== '') lines.push(new Array(depth * 2 + 1).join(' ') + line);
  }
  function renderChildren(value, depth) {
    (value.content || []).forEach(function (child) { render(child, depth); });
  }
  function renderRows(collectionId, depth, schemaNames) {
    var rows = Object.keys(blocks).map(function (id) { return blocks[id]; }).filter(function (row) {
      return row.parent_table === 'collection' && row.parent_id === collectionId;
    });
    rows.forEach(function (row) {
      if (visited >= config.maxBlocks) return;
      visited += 1;
      var cells = [textOf(row)];
      Object.keys(row.properties || {}).forEach(function (name) {
        if (name === 'title') return;
        var label = schemaNames[name] ? schemaNames[name] + ': ' : '';
        var text = richText(row.properties[name]);
        if (text) cells.push(label + text);
      });
      push(depth, cells.join(' | '));
    });
    return rows.length;
  }
  function render(id, depth, columnOrder) {
    var value = blocks[id];
    if (!value || visited >= config.maxBlocks) return;
    visited += 1;
    var text = textOf(value);
    var line = null;
    var recurse = true;
    var childDepth = depth + 1;
    switch (value.type) {
      case 'page':
        var href = origin + '/' + id.replace(/-/g, '');
        addLink(href, text);
        line = text ? '[' + text + '](' + href + ')' : href;
        recurse = false;
        break;
      case 'header': line = '# ' + text; break;
      case 'sub_header': line = '## ' + text; break;
      case 'sub_sub_header': line = '### ' + text; break;
      case 'bulleted_list': line = '- ' + text; break;
      case 'numbered_list': line = '1. ' + text; break;
      case 'to_do': line = (propertyText(value, 'checked') === 'Yes' ? '[x] ' : '[ ] ') + text; break;
      case 'quote': line = '> ' + text; break;
      case 'toggle': line = '> ' + text; break;
      case 'callout': line = text; break;
      case 'divider': line = '---'; break;
      case 'code': line = '```' + propertyText(value, 'language') + '\n' + text + '\n```'; break;
      case 'column_list':
      case 'column':
        childDepth = depth;
        break;
      case 'table':
        columnOrder = (value.format && value.format.table_block_column_order) || null;
        break;
      case 'table_row':
        var order = columnOrder || Object.keys(value.properties || {});
        line = order.map(function (name) { return richText((value.properties || {})[name]); }).join(' | ');
        recurse = false;
        break;
      case 'transclusion_reference':
        var source = blocks[value.format && value.format.transclusion_reference_pointer && value.format.transclusion_reference_pointer.id];
        if (source) {
          renderChildren(source, depth);
        }
        recurse = false;
        break;
      case 'collection_view':
      case 'collection_view_page':
      case 'child_database':
        var collectionId = value.collection_id || (value.format && value.format.collection_pointer && value.format.collection_pointer.id);
        var schema = collections[collectionId] && collections[collectionId].schema;
        var schemaNames = {};
        if (schema) Object.keys(schema).forEach(function (key) { schemaNames[key] = schema[key].name; });
        line = text || 'Database';
        push(depth, line);
        renderRows(collectionId, depth + 1, schemaNames);
        recurse = false;
        break;
      case 'bookmark':
      case 'embed':
      case 'link_preview':
      case 'image':
      case 'video':
      case 'file':
      case 'pdf':
      case 'audio':
        var address = propertyText(value, 'source') || propertyText(value, 'link');
        addLink(address, text);
        line = text && address ? text + ' ' + address : (text || address);
        break;
      case 'equation': line = propertyText(value, 'title') || text; break;
      default: line = text || null;
    }
    push(depth, line);
    if (recurse) {
      (value.content || []).forEach(function (child) { render(child, childDepth, columnOrder); });
    }
  }
  nextChunk({ stack: [] })
    .then(function () {
      return syncRound().catch(function (error) {
        result.sync_error = String((error && error.message) || error);
      });
    })
    .then(function () {
      if (!blocks[pageId]) throw new Error('Notion did not return the page.');
      renderChildren(blocks[pageId], 0);
      var text = lines.join('\n');
      window.__arcPull = { text: text };
      result.links = links;
      result.chars = text.length;
      result.blocks = visited;
      result.chunks = chunk;
      result.rounds = rounds;
      result.sync_error = result.sync_error || null;
      result.state = 'done';
    })
    .catch(function (error) {
      result.state = 'failed';
      result.error = String((error && error.message) || error);
    });
}

/** Starts readNotion with the bounds from the settings. */
export function startNotionReadScript(config) {
  return `${asciiJson.toString()};
${readNotion.toString()};
readNotion(${JSON.stringify(config)});
asciiJson({ state: 'running' });`;
}

/** The state of readNotion: state, error, chars, blocks, chunks, rounds, and the links it found (bounded to most_links). */
export function notionStateScript(maxLinks) {
  return `${asciiJson.toString()};
(function (maxLinks) {
  var result = window.__arcNotion;
  if (!result) return asciiJson({ state: 'missing' });
  return asciiJson({
    state: result.state,
    error: result.error || null,
    chars: result.chars || 0,
    blocks: result.blocks || 0,
    chunks: result.chunks || 0,
    rounds: result.rounds || 0,
    sync_error: result.sync_error || null,
    links: (result.links || []).slice(0, maxLinks),
    links_found: (result.links || []).length
  });
})(${JSON.stringify(maxLinks)});`;
}
