'use strict';
const assert = require('assert');
const {createLogger} = require('../lib/log');

function capture() {
  const lines = [];
  return {lines, stream: {write: (s) => { lines.push(s); return true; }}};
}

const FIXED = new Date('2026-11-10T21:04:05.123Z');

describe('log', () => {
  it('writes one JSON object per line with t, level, event, msg, source', () => {
    const c = capture();
    const log = createLogger({stream: c.stream, now: () => FIXED});
    log.info('mirror.page', 'applied one page', {page: 3});
    assert.strictEqual(c.lines.length, 1);
    assert.ok(c.lines[0].endsWith('\n'));
    assert.strictEqual(c.lines[0].indexOf('\n'), c.lines[0].length - 1);
    const rec = JSON.parse(c.lines[0]);
    assert.deepStrictEqual(rec, {
      t: '2026-11-10T21:04:05.123Z', level: 'info', event: 'mirror.page',
      msg: 'applied one page', source: 'registry', page: 3
    });
  });

  it('has the four levels', () => {
    const c = capture();
    const log = createLogger({stream: c.stream, now: () => FIXED});
    log.debug('a', 'a'); log.info('b', 'b'); log.warn('c', 'c'); log.error('d', 'd');
    assert.deepStrictEqual(c.lines.map((l) => JSON.parse(l).level), ['debug', 'info', 'warn', 'error']);
  });

  it('redacts secret-named fields by construction, at any depth', () => {
    const c = capture();
    const log = createLogger({stream: c.stream, now: () => FIXED});
    log.info('auth.exchange', 'token issued', {
      token: 'abc-secret-1', gateway: 'gw-1',
      nested: {signed_timestamp: 'def-secret-2', privateKey: 'ghi-secret-3', ok: 1},
      authorization: 'Bearer jkl-secret-4', secret: 'mno', signature: 'pqr', apiKey: 'stu',
      key: 'vwx', password: 'yz', cookie: 'c1', record: {tools: []}, body: 'b1'
    });
    const line = c.lines[0];
    for (const s of ['abc-secret-1', 'def-secret-2', 'ghi-secret-3', 'jkl-secret-4', 'mno', 'pqr', 'stu', 'vwx', 'yz', 'c1', 'b1']) {
      assert.ok(!line.includes(s), `${s} leaked: ${line}`);
    }
    const rec = JSON.parse(line);
    assert.strictEqual(rec.gateway, 'gw-1');
    assert.strictEqual(rec.token, '[redacted]');
    assert.strictEqual(rec.nested.ok, 1);
    assert.strictEqual(rec.nested.signed_timestamp, '[redacted]');
    assert.strictEqual(rec.record, '[redacted]');
  });

  it('does not let fields overwrite t, level, event, msg or source', () => {
    const c = capture();
    const log = createLogger({stream: c.stream, now: () => FIXED});
    log.warn('x.y', 'm', {level: 'debug', t: 'never', event: 'z', msg: 'n', source: 'worker'});
    const rec = JSON.parse(c.lines[0]);
    assert.strictEqual(rec.level, 'warn');
    assert.strictEqual(rec.t, '2026-11-10T21:04:05.123Z');
    assert.strictEqual(rec.event, 'x.y');
    assert.strictEqual(rec.msg, 'm');
    assert.strictEqual(rec.source, 'registry');
  });

  it('bounds a record at 8 KB by cutting long string values', () => {
    const c = capture();
    const log = createLogger({stream: c.stream, now: () => FIXED});
    log.info('x', 'm', {detail: 'a'.repeat(20000)});
    assert.ok(Buffer.byteLength(c.lines[0]) <= 8192, `record is ${Buffer.byteLength(c.lines[0])} bytes`);
    const rec = JSON.parse(c.lines[0]);
    assert.match(rec.detail, /…\(20000 bytes\)$/);
  });
});
