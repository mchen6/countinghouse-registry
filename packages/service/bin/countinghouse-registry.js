#!/usr/bin/env node
'use strict';
// countinghouse-registry --config <path>
const path = require('path');
const {parseArgs} = require('util');
const {loadConfig, ConfigError} = require('../lib/config/load');
const {loadSecret, SecretError} = require('../lib/auth/secret');
const {createAuth} = require('../lib/auth/middleware');
const {openStore} = require('../lib/store');
const {createApp} = require('../lib/app');
const {createLogger} = require('../lib/log');
const {createUpstreamClient} = require('../lib/mirror/client');
const {createMirror} = require('../lib/mirror/scheduler');
const {applyUpstreams} = require('../lib/mirror/sources');
const {conflictLogger} = require('../lib/publish/conflicts');
const {applyClaims, ClaimError} = require('../lib/publish/namespaces');
const {applyInstances} = require('../lib/enable/enable');
const pkg = require('../package.json');

async function main() {
  const {values} = parseArgs({options: {config: {type: 'string'}}});
  if (!values.config) {
    process.stderr.write('usage: countinghouse-registry --config <path>\n');
    process.exit(2);
  }
  const log = createLogger();
  let config;
  try {
    config = loadConfig(values.config);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  // The token secret (spec 10.3: secret.file, by default beside the store, or
  // COUNTINGHOUSE_REGISTRY_SECRET) and the configured keys, before the store is
  // opened: either refusing stops the start with exit 2.
  let auth;
  try {
    const secret = loadSecret({file: config.secret.file || path.join(path.dirname(config.store.path), '.jwt-secret')});
    auth = createAuth({config, secret, log});
  } catch (err) {
    if (!(err instanceof SecretError || err instanceof ConfigError)) throw err;
    process.stderr.write(`countinghouse-registry: ${err.message}\n`);
    process.exit(2);
  }
  const store = await openStore(config.store.path);
  // The claimed namespaces (spec 13.3: a removed claim holding local records
  // refuses startup) and then the configured upstream list (order, additions,
  // removals, url changes, spec 6.8) are applied before anything is served.
  try {
    await applyClaims(store, config.claims, new Date().toISOString());
  } catch (err) {
    if (!(err instanceof ClaimError)) throw err;
    process.stderr.write(`countinghouse-registry: ${err.message}\n`);
    await store.close();
    process.exit(2);
  }
  const removed = await applyInstances(store, config.instances.map((i) => i.instance), new Date().toISOString());
  if (removed.length) log.warn('enable.instances.removed', 'disabled the entries of instances no longer configured', {gateways: removed});
  const {rebuilt} = await applyUpstreams(store, config.upstreams, new Date().toISOString(), {onConflict: conflictLogger(log)});
  if (rebuilt) log.info('mirror.upstreams', 'applied the upstream list', {upstreams: config.upstreams.length});
  const userAgent = `countinghouse-registry/${pkg.version} (+https://github.com/mchen6/countinghouse-registry)`;
  const scheduler = createMirror({store, log, config,
    clientFor: (u) => createUpstreamClient({baseUrl: u.url, userAgent, maxDelayMs: u.intervalMinutes * 60000})});
  const app = createApp({store, config, log, auth, mirror: scheduler});
  const server = app.listen(config.listen.port, config.listen.host, () => {
    log.info('service.listen', 'listening', {host: config.listen.host, port: config.listen.port});
    scheduler.start();
  });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    log.info('service.stop', 'stopping', {signal});
    server.close(() => {
      scheduler.stop().then(() => store.close()).then(() => process.exit(0), (err) => {
        log.error('service.stop.failed', 'the store did not close cleanly', {code: err.code || err.name});
        process.exit(1);
      });
    });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`countinghouse-registry: ${err.message}\n`);
  process.exit(1);
});
