// Python-faithful JSON serializer for the Meaning Search process leaves.
//
// WHY THIS EXISTS (L108 preserve-behavior): the Python leaves emit their output
// with `json.dumps(..., separators=(",",":"))`. Downstream stages read that text.
// A naive `JSON.stringify` diverges from CPython on three points that matter for
// byte-identity of the SEARCH chain:
//
//   1. FLOATS. CPython renders a float with a mandatory decimal point:
//      json.dumps(1.0) => "1.0", json.dumps(0.0) => "0.0", json.dumps(-0.0) => "-0.0".
//      JSON.stringify(1.0) => "1". The Meaning Search leaves emit COMPUTED floats
//      (cosine `score` rounded to 6dp, `min_score`, embedding `vector` elements
//      that Python builds with `float(...)`). Those must render Python-style.
//      Mark such values with `pyFloat(x)` so the serializer prints the decimal.
//      (For non-integer finite doubles CPython shortest-repr and V8
//      Number->string produce the SAME digits, so pyFloat only has to FORCE the
//      trailing ".0" on integer-valued floats and preserve "-0.0".)
//
//   2. ensure_ascii. CPython default `ensure_ascii=True` escapes every non-ASCII
//      code point to \uXXXX (surrogate pairs become two \u escapes). One leaf
//      (assert-semantic-index-readiness) uses ensure_ascii=False and emits raw
//      UTF-8. The `ensureAscii` option selects the exact behavior. Control chars
//      below 0x20 use the same short escapes in both runtimes (\b \t \n \f \r)
//      and \u00XX otherwise, and both escape the double-quote and backslash.
//
//   3. compact separators. `(",",":")` means no spaces, which is what this
//      emitter produces (matching CPython compact mode).
//
// KNOWN, HONESTLY-NAMED RESIDUAL (JSON-invisible): a value that arrives via
// JSON.parse loses Python int-vs-float lexeme distinction (`5.0` parses to the
// Number 5). A pass-through number that was a float-with-no-fraction in the input
// would re-emit as "5" here and "5.0" in Python. This only affects values copied
// verbatim from parsed input; every COMPUTED float in these leaves is wrapped in
// pyFloat, so the search-path outputs are faithful. Exponential-form doubles
// (very small or very large) are not produced by rounded scores or normalized
// embedding vectors; if one ever occurred the exponent zero-pad differs (Python
// "1e-07" vs JS "1e-7") and would need handling. Noted, not hit today.

const PY_FLOAT = Symbol("pyFloat");

// Wrap a Number so the serializer renders it as a Python float (forces ".0" on
// integer values, preserves "-0.0"). Use for every COMPUTED float.
export function pyFloat(value) {
  return { [PY_FLOAT]: true, value: Number(value) };
}

function isPyFloat(value) {
  return value !== null && typeof value === "object" && value[PY_FLOAT] === true;
}

function reprFloat(x) {
  if (!Number.isFinite(x)) {
    // CPython json.dumps emits NaN/Infinity/-Infinity bare; the leaves never
    // produce these, but mirror CPython rather than throwing.
    if (Number.isNaN(x)) return "NaN";
    return x > 0 ? "Infinity" : "-Infinity";
  }
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const ax = Math.abs(x);
  // CPython float repr uses scientific notation for |x| < 1e-4 or |x| >= 1e16
  // with a sign and a >=2-digit zero-padded exponent ("1e-05", "9.999e-05",
  // "1e+16"); JS toString diverges there ("0.00001", "1e-7"). Reproduce it.
  if (ax < 1e-4 || ax >= 1e16) {
    const s = x.toExponential();
    const m = s.match(/^(-?)(\d(?:\.\d+)?)e([+-])(\d+)$/);
    const [, sign, mant, esign, edig] = m;
    const exp = edig.length < 2 ? edig.padStart(2, "0") : edig;
    return `${sign}${mant}e${esign}${exp}`;
  }
  if (Number.isInteger(x)) return `${x}.0`;
  // Fixed-point range [1e-4, 1e16): V8 shortest-repr equals CPython repr and JS
  // does not use exponent form here, so String(x) matches byte-for-byte.
  return String(x);
}

function escapeString(s, ensureAscii) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (code === 0x08) {
      out += "\\b";
    } else if (code === 0x09) {
      out += "\\t";
    } else if (code === 0x0a) {
      out += "\\n";
    } else if (code === 0x0c) {
      out += "\\f";
    } else if (code === 0x0d) {
      out += "\\r";
    } else if (code < 0x20) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else if (code < 0x80) {
      out += ch;
    } else if (ensureAscii) {
      // Emit the raw UTF-16 code unit as \uXXXX. Surrogate pairs become two \u
      // escapes, exactly as CPython ensure_ascii does.
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function encode(value, ensureAscii) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (isPyFloat(value)) {
    return reprFloat(value.value);
  }
  const t = typeof value;
  if (t === "boolean") {
    return value ? "true" : "false";
  }
  if (t === "number") {
    // Unwrapped Number: Python int semantics. Integer => "N"; a non-integer
    // finite double => shortest repr (matches CPython float repr). See residual note.
    if (Number.isInteger(value)) {
      return Object.is(value, -0) ? "0" : String(value);
    }
    return reprFloat(value);
  }
  if (t === "string") {
    return escapeString(value, ensureAscii);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => encode(v, ensureAscii)).join(",") + "]";
  }
  if (value instanceof Map) {
    // A Map serializes as a JSON object in INSERTION order. Plain JS objects
    // reorder integer-like string keys (e.g. "1000" ahead of "0111"), which
    // diverges from CPython dict order; callers that need Python order (the ANN
    // bucket tables, whose keys are integer-like bit-strings) pass a Map.
    const parts = [];
    for (const [key, v] of value) {
      parts.push(escapeString(String(key), ensureAscii) + ":" + encode(v, ensureAscii));
    }
    return "{" + parts.join(",") + "}";
  }
  if (t === "object") {
    const parts = [];
    for (const key of Object.keys(value)) {
      parts.push(escapeString(key, ensureAscii) + ":" + encode(value[key], ensureAscii));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new TypeError(`Object of type ${t} is not JSON serializable`);
}

// Faithful equivalent of json.dumps(value, separators=(",",":"), ensure_ascii=<flag>).
export function pyDumps(value, { ensureAscii = true } = {}) {
  return encode(value, ensureAscii);
}
