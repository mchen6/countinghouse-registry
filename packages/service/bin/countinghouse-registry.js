#!/usr/bin/env node
'use strict';
// countinghouse-registry --config <path>
const {parseArgs} = require('util');
const {loadConfig} = require('../lib/config/load');
const {openStore} = require('../lib/store');
const {createApp} = require('../lib/app');
const {createLogger} = require('../lib/log');

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
  const server = app.listen(config.listen.port, config.listen.host, () => {
    log.info('service.listen', 'listening', {host: config.listen.host, port: config.listen.port});
  });
  const stop = (signal) => {
    log.info('service.stop', 'stopping', {signal});
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`countinghouse-registry: ${err.message}\n`);
  process.exit(1);
});
