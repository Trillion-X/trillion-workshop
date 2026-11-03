// Shared URL substitution used by source composition and the visual canvas.
// Keep the surrounding CSS and quoting unchanged unless the URL itself changes.

function escapedCharacter(source, index) {
  let next = index + 1;
  if (next >= source.length) return { value: '\\', end: next };
  if (source[next] === '\n' || source[next] === '\f') return { value: '', end: next + 1 };
  if (source[next] === '\r') return { value: '', end: source[next + 1] === '\n' ? next + 2 : next + 1 };
  const hex = /^[\da-f]{1,6}/i.exec(source.slice(next));
  if (hex) {
    next += hex[0].length;
    if (/[\t\n\f\r ]/.test(source[next] ?? '')) {
      if (source[next] === '\r' && source[next + 1] === '\n') next += 2;
      else next++;
    }
    const codePoint = Number.parseInt(hex[0], 16);
    return { value: String.fromCodePoint(codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff) ? 0xfffd : codePoint), end: next };
  }
  return { value: source[next], end: next + 1 };
}

function readString(source, start) {
  const quote = source[start];
  let value = '';
  for (let index = start + 1; index < source.length;) {
    const char = source[index];
    if (char === quote) return { value, end: index + 1 };
    if (char === '\n' || char === '\r' || char === '\f') return null;
    if (char === '\\') {
      const escaped = escapedCharacter(source, index);
      value += escaped.value;
      index = escaped.end;
    } else {
      value += char;
      index++;
    }
  }
  return null;
}

function skipSpaceAndComments(source, start) {
  let index = start;
  while (index < source.length) {
    if (/[\t\n\f\r ]/.test(source[index])) { index++; continue; }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      if (close < 0) return source.length;
      index = close + 2;
      continue;
    }
    break;
  }
  return index;
}

function serializeUrl(value, quote) {
  const text = String(value);
  if (!quote && !/[\s"'()\\\0-\x1f\x7f]/.test(text)) return text;
  const delimiter = quote || '"';
  return `${delimiter}${text.replaceAll('\\', '\\\\').replaceAll(delimiter, `\\${delimiter}`).replace(/[\0-\x1f\x7f]/g, char => {
    const code = char.codePointAt(0).toString(16);
    return `\\${code} `;
  })}${delimiter}`;
}

function resourceEdit(start, end, value, rewrite, quote) {
  const rewritten = rewrite(value);
  if (rewritten === value) return null;
  return { start, end, text: serializeUrl(rewritten, quote) };
}

function readUrlFunction(source, start, rewrite) {
  if (!/^url\(/i.test(source.slice(start))) return null;
  const open = start + 3;
  let index = skipSpaceAndComments(source, open + 1);
  if (index >= source.length) return null;
  if (source[index] === '"' || source[index] === "'") {
    const parsed = readString(source, index);
    if (!parsed) return null;
    const close = skipSpaceAndComments(source, parsed.end);
    if (source[close] !== ')') return null;
    return { end: close + 1, edit: resourceEdit(index, parsed.end, parsed.value, rewrite, source[index]) };
  }
  const valueStart = index;
  let value = '';
  for (; index < source.length && source[index] !== ')';) {
    if (/[\t\n\f\r ]/.test(source[index])) {
      let close = index;
      while (/[\t\n\f\r ]/.test(source[close] ?? '')) close++;
      if (source[close] !== ')') return null;
      return { end: close + 1, edit: resourceEdit(valueStart, index, value, rewrite) };
    } else if (/["'(\0-\x08\x0b\x0e-\x1f\x7f]/.test(source[index])) {
      return null;
    } else if (source[index] === '\\') {
      if (index + 1 >= source.length || /[\n\r\f]/.test(source[index + 1])) return null;
      const escaped = escapedCharacter(source, index);
      value += escaped.value;
      index = escaped.end;
    } else {
      value += source[index++];
    }
  }
  if (index >= source.length) return null;
  return { end: index + 1, edit: resourceEdit(valueStart, index, value, rewrite) };
}

/** Rewrite actual CSS url() and quoted @import resources, leaving comments and strings alone. */
export function mapCssResourceUrls(content, rewrite) {
  const edits = [];
  for (let index = 0; index < content.length;) {
    if (content.startsWith('/*', index)) {
      const close = content.indexOf('*/', index + 2);
      if (close < 0) break;
      index = close + 2;
      continue;
    }
    const char = content[index];
    if (char === '"' || char === "'") {
      const parsed = readString(content, index);
      if (!parsed) break;
      index = parsed.end;
      continue;
    }
    if (char === '@' && /^@import\b/i.test(content.slice(index))) {
      const quoteStart = skipSpaceAndComments(content, index + 7);
      if (content[quoteStart] === '"' || content[quoteStart] === "'") {
        const parsed = readString(content, quoteStart);
        if (parsed) {
          const edit = resourceEdit(quoteStart, parsed.end, parsed.value, rewrite, content[quoteStart]);
          if (edit) edits.push(edit);
          index = parsed.end;
          continue;
        }
      }
    }
    if ((char === 'u' || char === 'U') && (index === 0 || !/[\w-]/.test(content[index - 1]))) {
      const parsed = readUrlFunction(content, index, rewrite);
      if (parsed) {
        if (parsed.edit) edits.push(parsed.edit);
        index = parsed.end;
        continue;
      }
    }
    index++;
  }
  for (const edit of edits.reverse()) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  return content;
}
