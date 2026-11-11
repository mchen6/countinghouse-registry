'use strict';
// The exchange rate limit (spec 10.2, numbers the implementer's call): per
// source address, at most `perMinute` requests in any 60 s, then 429 with the
// seconds until the oldest leaves the window. In memory only: the address is
// never logged or stored (spec 9.6).
// A source is an IPv4 address, or an IPv6 /64 (one host is commonly given a
// whole /64); an IPv4-mapped IPv6 address is its IPv4 address. At most
// `maxSources` are held, the least recently seen dropped first, so memory stays
// bounded under a flood of addresses.
const net = require('net');

const WINDOW_MS = 60000;

function sourceKey(address) {
  if (net.isIPv6(address)) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return mapped[1];
    const groups = (part) => (part ? part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
    const [head, tail] = address.split('::');
    const left = groups(head);
    const right = tail === undefined ? [] : groups(tail);
    const all = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
  }
  return address;
}

function createRateLimiter({perMinute = 10, maxSources = 10000, now = () => Date.now()} = {}) {
  const bySource = new Map(); // source -> request times (ms), oldest first; least recently seen first

  const sweep = (t) => {
    for (const [source, times] of bySource) {
      if (t - times[times.length - 1] >= WINDOW_MS) bySource.delete(source);
    }
  };
  let lastSweep = 0;

  return {
    // -> {ok, retryAfterSec}
    take(address) {
      const source = sourceKey(address);
      const t = now();
      if (t - lastSweep >= WINDOW_MS) {
        sweep(t);
        lastSweep = t;
      }
      const times = (bySource.get(source) || []).filter((at) => t - at < WINDOW_MS);
      bySource.delete(source);
      const ok = times.length < perMinute;
      if (ok) times.push(t);
      bySource.set(source, times);
      if (bySource.size > maxSources) bySource.delete(bySource.keys().next().value);
      return ok ? {ok, retryAfterSec: 0} : {ok, retryAfterSec: Math.max(1, Math.ceil((times[0] + WINDOW_MS - t) / 1000))};
    },
    size: () => bySource.size
  };
}

module.exports = {createRateLimiter, sourceKey};
