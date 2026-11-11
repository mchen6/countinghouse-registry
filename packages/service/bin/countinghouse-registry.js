#!/usr/bin/env node
'use strict';
// countinghouse-registry --config <path>
const {parseArgs} = require('util');
const {loadConfig} = require('../lib/config/load');
const {openStore} = require('../lib/store');
const {createApp} = require('../lib/app');
const {createLogger} = require('../lib/log');
const {createUpstreamClient} = require('../lib/mirror/client');
const {createScheduler} = require('../lib/mirror/scheduler');
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
  const store = await openStore(config.store.path);
  const app = createApp({store, config, log});
  const client = createUpstreamClient({
    baseUrl: config.upstream.url,
    userAgent: `countinghouse-registry/${pkg.version} (+https://github.com/mchen6/countinghouse-registry)`,
    maxDelayMs: config.upstream.intervalMinutes * 60000
  });
  const scheduler = createScheduler({store, client, log, config});
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
