'use strict';
// Responses in upstream's wire form: JSON bodies as `application/json`, errors as
// RFC 9457 problem details (`application/problem+json`, {title, status, detail}),
// which is what the official registry sends in production (research note §2).
const http = require('http');

// res.setHeader, not Express's res.set: res.set appends "; charset=utf-8" to
// application/json, and upstream sends the bare type.
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.end(text);
}

function problem(res, status, detail, extra = {}) {
  const text = JSON.stringify({title: http.STATUS_CODES[status], status, detail, ...extra});
  res.status(status);
  res.setHeader('Content-Type', 'application/problem+json');
  res.end(text);
}

// Wraps an async handler: an unexpected error is logged by code and answered as a
// 500 problem with a fixed detail, never the error's own message.
function handle(log, failDetail, fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      log.error('http.handler.error', 'a request handler failed', {route: req.route && req.route.path, code: err.code || err.name});
      if (!res.headersSent) problem(res, 500, failDetail);
    });
  };
}

module.exports = {sendJson, problem, handle};
