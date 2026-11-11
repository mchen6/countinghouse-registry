'use strict';
// CORS on the public read routes, as upstream sends it (checked 2026-11-10):
// `Access-Control-Allow-Origin: *` and the expose header on responses, and a 204
// preflight that allows GET with the requested headers for a day. Write,
// operator and instance routes get no CORS headers (spec section 4.1).

const READ = new Set(['GET', 'HEAD']);

function readCors(req, res, next) {
  if (req.method === 'OPTIONS') {
    if (!READ.has(req.get('Access-Control-Request-Method'))) return next();
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET');
    const asked = req.get('Access-Control-Request-Headers');
    if (asked) res.set('Access-Control-Allow-Headers', asked);
    res.set('Access-Control-Max-Age', '86400');
    res.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    res.status(204).end();
    return;
  }
  if (READ.has(req.method)) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Expose-Headers', 'Content-Type, Content-Length');
  }
  next();
}

module.exports = {readCors};
