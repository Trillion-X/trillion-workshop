// Estimate the JavaScript shape JSON.parse will allocate without materializing it.
// Kept dependency-free so storage owners and browser clients can share one accounting model.
export const OBJECT_PROPERTY_BYTES = 16;

export function jsonExpansionBytes(json, mostBytes = Infinity) {
  let bytes = 0;
  let rows = 0;
  let at = 0;
  const stack = [];
  let rootState = 'value';
  const whitespace = code => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  const skipWhitespace = () => { while (at < json.length && whitespace(json.charCodeAt(at))) at += 1; };
  const stringLength = () => {
    at += 1; // opening quote
    let units = 0;
    while (at < json.length) {
      const code = json.charCodeAt(at++);
      if (code === 0x22) return units;
      if (code === 0x5c) {
        const escaped = json.charCodeAt(at++);
        if (escaped === 0x75) { at += 4; units += 1; }
        else units += 1;
      } else if (code >= 0xd800 && code <= 0xdbff && json.charCodeAt(at) >= 0xdc00 && json.charCodeAt(at) <= 0xdfff) {
        at += 1;
        units += 2;
      } else units += 1;
    }
    return units;
  };
  const completeValue = () => {
    if (stack.length) stack[stack.length - 1].state = 'commaOrEnd';
    else rootState = 'done';
  };
  const beginValue = () => {
    const parent = stack[stack.length - 1];
    if (parent?.type === 'array') bytes += 8;
    const code = json.charCodeAt(at);
    if (code === 0x5b) { bytes += 32; rows += 1; at += 1; stack.push({ type: 'array', state: 'valueOrEnd' }); }
    else if (code === 0x7b) { bytes += 64; rows += 1; at += 1; stack.push({ type: 'object', state: 'keyOrEnd' }); }
    else if (code === 0x22) { bytes += 16 + stringLength() * 2; rows += 1; completeValue(); }
    else {
      while (at < json.length && json.charCodeAt(at) !== 0x2c && json.charCodeAt(at) !== 0x5d
        && json.charCodeAt(at) !== 0x7d && !whitespace(json.charCodeAt(at))) at += 1;
      bytes += 16;
      rows += 1;
      completeValue();
    }
  };

  while (at < json.length) {
    if (bytes > mostBytes) break;
    skipWhitespace();
    if (at >= json.length) break;
    const frame = stack[stack.length - 1];
    const code = json.charCodeAt(at);
    if (!frame) {
      if (rootState === 'value') beginValue();
      else break;
    } else if (frame.type === 'array') {
      if (frame.state === 'valueOrEnd' || frame.state === 'value') {
        if (code === 0x5d) { at += 1; stack.pop(); completeValue(); }
        else beginValue();
      } else if (code === 0x2c) { at += 1; frame.state = 'value'; }
      else if (code === 0x5d) { at += 1; stack.pop(); completeValue(); }
      else at += 1;
    } else if (frame.state === 'keyOrEnd' || frame.state === 'key') {
      if (code === 0x7d) { at += 1; stack.pop(); completeValue(); }
      else if (code === 0x22) { bytes += OBJECT_PROPERTY_BYTES + stringLength() * 2; frame.state = 'colon'; }
      else at += 1;
    } else if (frame.state === 'colon') {
      if (code === 0x3a) { at += 1; frame.state = 'value'; }
      else at += 1;
    } else if (frame.state === 'value') beginValue();
    else if (code === 0x2c) { at += 1; frame.state = 'key'; }
    else if (code === 0x7d) { at += 1; stack.pop(); completeValue(); }
    else at += 1;
  }
  return { rows, bytes };
}
