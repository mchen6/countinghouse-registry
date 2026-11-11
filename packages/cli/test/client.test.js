'use strict';
// The shared registry client, without a server: how answers it cannot read and
// refusals it cannot fully describe come out.
const assert = require('assert');
const {createClient, ApiError, CliError, recordPath, X} = require('../lib/client');

const REGISTRY = 'https://registry.example.org';
const reset = () => Object.assign(new TypeError('terminated'), {cause: Object.assign(new Error('read ECONNRESET'), {code: 'ECONNRESET'})});

describe('client', () => {
  it('a connection reset while the answer is read is exit 2 "could not be reached", never the body', async () => {
    const fetch = async () => ({status: 200, text: () => Promise.reject(reset())});
    const client = createClient({registry: REGISTRY, fetch});
    await assert.rejects(client.request('POST', '/v0.1/publish', {body: {}}), (err) => {
      assert.ok(err instanceof CliError, err && err.stack);
      assert.strictEqual(err.exitCode, 2);
      assert.strictEqual(err.message, `POST ${REGISTRY}/v0.1/publish: the registry could not be reached (ECONNRESET)`);
      return true;
    });
  });

  it('a 422 whose errors are strings or carry no message prints each one, never "undefined"', () => {
    const err = new ApiError('POST', '/v0.1/publish', 422, {title: 'Unprocessable Entity', detail: 'invalid', errors: [
      'version is required', {location: 'body.name', message: 'too short'}, {location: 'body.x'}, {}
    ]});
    assert.deepStrictEqual(err.issues, ['version is required', 'body.name: too short', '{"location":"body.x"}', '{}']);
    assert.ok(!err.message.includes('undefined'), err.message);
  });

  it('recordPath is the one place the record endpoint is spelled', () => {
    assert.strictEqual(recordPath('com.example/echo', '1.0.0+b'), `${X}/records/com.example%2Fecho/versions/1.0.0%2Bb`);
  });
});
