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
  if (!box) return asciiJson({ found: false });
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
