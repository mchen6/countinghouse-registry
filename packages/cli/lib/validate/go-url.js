'use strict';
// Go's net/url.Parse (Go 1.26, the toolchain upstream builds with at 7e8fa024), as
// far as upstream's validators observe it: whether it fails and with what message,
// the scheme (lowercased), the host, the hostname and the unescaped path. Follows
// src/net/url/url.go: Parse splits off the fragment, parse() rejects control
// characters, reads the scheme (getScheme), drops the query, refuses a colon in a
// scheme-less first segment, parses "//authority" (parseAuthority, parseHost:
// a bracketed IPv6 literal from the last '[', else the port from the first ':'
// under the default urlstrictcolons=1), and unescapes host, path and fragment with
// their modes (unescape, shouldEscape and encoding_table.go).
const net = require('net');

// Bytes shouldEscape(c, encodeHost) keeps (encoding_table.go).
const HOST_SAFE = new Set("!\"$&'()*+,-.0123456789:;<=>ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz~");
const isHex = (c) => /^[0-9A-Fa-f]$/.test(c);

class GoURLError extends Error {}

// unescape(s, mode) for the modes parse uses: 'host', 'zone', 'path', 'fragment'.
function unescape(s, mode) {
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '%') {
      if (i + 2 >= s.length || !isHex(s[i + 1]) || !isHex(s[i + 2])) throw new GoURLError(`invalid URL escape ${JSON.stringify(s.slice(i, i + 3))}`);
      const v = parseInt(s.slice(i + 1, i + 3), 16);
      const esc = s.slice(i, i + 3);
      if (mode === 'host' && v < 0x80 && esc !== '%25') throw new GoURLError(`invalid URL escape ${JSON.stringify(esc)}`);
      if (mode === 'zone' && esc !== '%25' && v !== 0x20 && v < 0x80 && !HOST_SAFE.has(String.fromCharCode(v))) throw new GoURLError(`invalid URL escape ${JSON.stringify(esc)}`);
      out += String.fromCharCode(v);
      i += 3;
      continue;
    }
    if ((mode === 'host' || mode === 'zone') && c.charCodeAt(0) < 0x80 && !HOST_SAFE.has(c)) {
      throw new GoURLError(`invalid character ${JSON.stringify(c)} in host name`);
    }
    out += c;
    i++;
  }
  // Bytes to a JS string: decode the %XX bytes of non-ASCII as UTF-8 where they form it.
  return /[\x80-\xff]/.test(out) ? Buffer.from(out, 'latin1').toString('utf8') : out;
}

function getScheme(raw) {
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (/[A-Za-z]/.test(c)) continue;
    if (/[0-9+.-]/.test(c)) { if (i === 0) return ['', raw]; continue; }
    if (c === ':') { if (i === 0) throw new GoURLError('missing protocol scheme'); return [raw.slice(0, i), raw.slice(i + 1)]; }
    return ['', raw];
  }
  return ['', raw];
}

const validOptionalPort = (port) => port === '' || (port[0] === ':' && /^[0-9]*$/.test(port.slice(1)));

function parseHost(host) {
  const open = host.lastIndexOf('[');
  if (open >= 0) {
    const close = host.lastIndexOf(']');
    if (close < 0) throw new GoURLError("missing ']' in host");
    const colonPort = host.slice(close + 1);
    if (!validOptionalPort(colonPort)) throw new GoURLError(`invalid port ${JSON.stringify(colonPort)} after host`);
    const inner = host.slice(open + 1, close);
    const zone = inner.indexOf('%25');
    const name = zone >= 0 ? unescape(inner.slice(0, zone), 'host') + unescape(inner.slice(zone), 'zone') : unescape(inner, 'host');
    // netip.ParseAddr: an IPv6 address (with an optional zone); an IPv4 one is refused.
    const kind = net.isIP(name);
    if (kind === 4) throw new GoURLError('invalid IP-literal');
    if (kind !== 6) throw new GoURLError(`invalid host: ParseAddr(${JSON.stringify(name)}): invalid address`);
    return `[${name}]${colonPort}`;
  }
  const i = host.indexOf(':');
  if (i >= 0 && !validOptionalPort(host.slice(i))) throw new GoURLError(`invalid port ${JSON.stringify(host.slice(i))} after host`);
  return unescape(host, 'host');
}

// URL.Hostname(): the host without its port, and without brackets.
function hostnameOf(host) {
  let h = host;
  const colon = h.lastIndexOf(':');
  if (colon >= 0 && validOptionalPort(h.slice(colon)) && (!h.startsWith('[') || h.lastIndexOf(']') < colon)) h = h.slice(0, colon);
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

function parse(raw) {
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new GoURLError('net/url: invalid control character in URL');
  const u = {scheme: '', host: '', hostname: '', path: ''};
  if (raw === '*') return {...u, path: '*'};
  const [scheme, afterScheme] = getScheme(raw);
  u.scheme = scheme.toLowerCase();
  let rest = afterScheme;
  if (rest.endsWith('?') && rest.split('?').length === 2) rest = rest.slice(0, -1);
  else { const q = rest.indexOf('?'); if (q >= 0) rest = rest.slice(0, q); }
  if (!rest.startsWith('/')) {
    if (u.scheme) return {...u, opaque: rest};
    const slash = rest.indexOf('/');
    if ((slash >= 0 ? rest.slice(0, slash) : rest).includes(':')) throw new GoURLError('first path segment in URL cannot contain colon');
  }
  if ((u.scheme || !rest.startsWith('///')) && rest.startsWith('//')) {
    let authority = rest.slice(2);
    rest = '';
    const slash = authority.indexOf('/');
    if (slash >= 0) { rest = authority.slice(slash); authority = authority.slice(0, slash); }
    const at = authority.lastIndexOf('@');
    if (at >= 0 && !/^[A-Za-z0-9\-._:~!$&'()*+,;=%@]*$/.test(authority.slice(0, at))) throw new GoURLError('net/url: invalid userinfo');
    u.host = parseHost(at >= 0 ? authority.slice(at + 1) : authority);
    u.hostname = hostnameOf(u.host);
  }
  u.path = unescape(rest, 'path');
  return u;
}

// -> {scheme, host, hostname, path} or {error: 'parse "<url before #>": <reason>'}.
function goParseURL(raw) {
  if (typeof raw !== 'string') return {error: 'not a string'};
  const hash = raw.indexOf('#');
  const main = hash >= 0 ? raw.slice(0, hash) : raw;
  let u;
  try {
    u = parse(main);
  } catch (err) {
    if (err instanceof GoURLError) return {error: `parse ${JSON.stringify(main)}: ${err.message}`};
    throw err;
  }
  if (hash >= 0) {
    try {
      unescape(raw.slice(hash + 1), 'fragment');
    } catch (err) {
      if (err instanceof GoURLError) return {error: `parse ${JSON.stringify(raw)}: ${err.message}`};
      throw err;
    }
  }
  return u;
}

module.exports = {goParseURL};
