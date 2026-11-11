'use strict';
// The byte length Go's encoding/json gives a JSON value, for upstream's 4 KiB cap on
// publisher-provided (internal/validators/validators.go validatePublisherExtensions
// at 7e8fa024: len(json.Marshal(...))). It differs from UTF-8 JSON.stringify in what
// Go escapes: '<', '>', '&', U+2028 and U+2029 as six-byte escapes, and
// a lone surrogate (invalid UTF-8 for Go) becomes U+FFFD. Numbers, other control
// characters and key order give the same length both ways. Iterative.

function stringSize(s) {
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) n += 2; // \" and \\
    else if (c === 0x3c || c === 0x3e || c === 0x26) n += 6; // < > &
    else if (c < 0x20) n += (c === 0x0a || c === 0x0d || c === 0x09 || c === 0x08 || c === 0x0c) ? 2 : 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c === 0x2028 || c === 0x2029) n += 6;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; } else n += 3; // BMP, or a lone surrogate as U+FFFD
  }
  return n;
}

function goJsonSize(value) {
  let n = 0;
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') n += stringSize(v);
    else if (Array.isArray(v)) { n += 2 + Math.max(0, v.length - 1); for (const x of v) stack.push(x); } else if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      n += 2 + Math.max(0, keys.length - 1);
      for (const k of keys) { n += stringSize(k) + 1; stack.push(v[k]); }
    } else n += JSON.stringify(v).length; // number, boolean, null
  }
  return n;
}

module.exports = {goJsonSize};
