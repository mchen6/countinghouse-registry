'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {loadConfig, ConfigError} = require('../lib/config/load');

const KEY = Buffer.alloc(32, 7).toString('base64');
const MIN = {store: {path: '/tmp/r.db'}, secret: {file: '/tmp/r.secret'}};

function write(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}

function refuses(obj, field) {
  assert.throws(() => loadConfig(write(obj)), (err) => {
    assert.ok(err instanceof ConfigError, `not a ConfigError: ${err}`);
    assert.strictEqual(err.field, field, err.message);
    return true;
  });
}

describe('config', () => {
  it('applies the defaults', () => {
    const c = loadConfig(write(MIN));
    assert.deepStrictEqual(c.listen, {host: '127.0.0.1', port: 9800, trustProxy: false});
    assert.deepStrictEqual(c.upstream, {
      url: 'https://registry.modelcontextprotocol.io', intervalMinutes: 60,
      reconcile: {everyDays: 7, atHour: 3}
    });
    assert.deepStrictEqual(c.claims, []);
    assert.deepStrictEqual(c.publisherKeys, []);
    assert.deepStrictEqual(c.instances, []);
    assert.strictEqual(c.publicHosting, 'aggregate');
  });

  it('is deeply frozen', () => {
    const c = loadConfig(write(MIN));
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.listen) && Object.isFrozen(c.upstream.reconcile));
  });

  it('refuses a file that is not JSON', () => refuses('{nope', ''));
  it('refuses an unknown field', () => refuses({...MIN, upstrem: {}}, '/upstrem'));
  it('refuses an unknown nested field', () => refuses({...MIN, listen: {hots: 'x'}}, '/listen/hots'));
  it('refuses a missing store', () => refuses({secret: MIN.secret}, '/store'));
  it('refuses intervalMinutes below 10', () => refuses({...MIN, upstream: {intervalMinutes: 9}}, '/upstream/intervalMinutes'));
  it('refuses reconcile.everyDays below 1', () => refuses({...MIN, upstream: {reconcile: {everyDays: 0}}}, '/upstream/reconcile/everyDays'));
  it('refuses reconcile.atHour outside 0-23', () => refuses({...MIN, upstream: {reconcile: {atHour: 24}}}, '/upstream/reconcile/atHour'));
  it('refuses a claim without a trailing slash', () => refuses({...MIN, claims: ['io.github.example']}, '/claims/0'));
  it('refuses a duplicate claim', () => refuses({...MIN, claims: ['com.example/', 'com.example/']}, '/claims/1'));
  it('refuses a non-boolean trustProxy', () => refuses({...MIN, listen: {trustProxy: 'yes'}}, '/listen/trustProxy'));
  it('trustProxy defaults to false', () => assert.strictEqual(loadConfig(write(MIN)).listen.trustProxy, false));
  it('refuses a port outside 1-65535', () => refuses({...MIN, listen: {port: 0}}, '/listen/port'));
  it('refuses a publicHosting other than aggregate and none', () => refuses({...MIN, publicHosting: 'all'}, '/publicHosting'));

  it('refuses a duplicate instance id', () => refuses({...MIN, instances: [
    {instance: 'gw-1', algorithm: 'ed25519', publicKey: KEY},
    {instance: 'gw-1', algorithm: 'ed25519', publicKey: KEY}
  ]}, '/instances/1/instance'));

  it('refuses an instance id that is not ^[a-z0-9][a-z0-9-]{0,62}$', () => refuses({...MIN, instances: [
    {instance: 'GW.example.com', algorithm: 'ed25519', publicKey: KEY}
  ]}, '/instances/0/instance'));

  it('refuses a publisher key namespace that is not a claim', () => refuses({...MIN, claims: ['com.example/'], publisherKeys: [
    {name: 'ops', algorithm: 'ed25519', publicKey: KEY, domains: ['example.com'], namespaces: ['org.other/'], operate: false}
  ]}, '/publisherKeys/0/namespaces/0'));

  it('refuses a duplicate publisher key name', () => refuses({...MIN, publisherKeys: [
    {name: 'ops', algorithm: 'ed25519', publicKey: KEY, domains: [], namespaces: [], operate: true},
    {name: 'ops', algorithm: 'ed25519', publicKey: KEY, domains: [], namespaces: [], operate: true}
  ]}, '/publisherKeys/1/name'));

  it('refuses an algorithm other than ed25519 and ecdsa-p384', () => refuses({...MIN, instances: [
    {instance: 'gw-1', algorithm: 'rsa', publicKey: KEY}
  ]}, '/instances/0/algorithm'));

  it('accepts a full config', () => {
    const c = loadConfig(write({...MIN, claims: ['io.github.example/'],
      publisherKeys: [{name: 'ops', algorithm: 'ed25519', publicKey: KEY, domains: ['example.com'], namespaces: ['io.github.example/'], operate: true}],
      instances: [{instance: 'gw-1', algorithm: 'ecdsa-p384', publicKey: KEY}],
      upstream: {intervalMinutes: 10, reconcile: {everyDays: 1, atHour: 0}}, publicHosting: 'none'}));
    assert.strictEqual(c.publisherKeys[0].operate, true);
    assert.strictEqual(c.upstream.intervalMinutes, 10);
  });
});
