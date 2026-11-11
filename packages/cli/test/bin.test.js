'use strict';
// The bin's argument handling, in process and without a server: every refusal
// here happens before any request.
const assert = require('assert');
const {main} = require('../bin/countinghouse-registry-cli');

function io() {
  const out = [];
  const err = [];
  const fetch = async () => { throw new Error('no request may be made'); };
  return {stdout: {write: (s) => out.push(String(s))}, stderr: {write: (s) => err.push(String(s))}, env: {}, fetch,
    out: () => out.join(''), err: () => err.join('')};
}

const SIGNED = ['--registry', 'https://registry.example.org', '--domain', 'ops.example.org', '--key', '/nonexistent'];

describe('the bin: options a command does not take', () => {
  const cases = [
    [['acknowledge', 'com.example/srv', '1.0.0', '--remove'], /^acknowledge does not take --remove\nusage: countinghouse-registry-cli acknowledge <name> <version>/],
    [['disable', 'gw-1', 'com.example/srv', '1.0.0', '--remote', '1'], /^disable does not take --remote\nusage: countinghouse-registry-cli disable <instance> <name> <version>/],
    [['conflicts', '--since', '3'], /^conflicts does not take --since\nusage: countinghouse-registry-cli conflicts/],
    [['register', '/tmp/x', '--upstream', 'a'], /^register does not take --upstream\nusage: countinghouse-registry-cli register <dir>/],
    [['generate', '/tmp/x', '--domain', 'ops.example.org'], /^generate does not take --domain\nusage: countinghouse-registry-cli generate <module dir>/]
  ];
  for (const [argv, re] of cases) {
    it(`refuses: ${argv.join(' ')}`, async () => {
      const t = io();
      const args = argv[0] === 'generate' ? [...argv, '--registry', 'https://registry.example.org'] : [...argv, ...SIGNED];
      assert.strictEqual(await main(args, t), 1, t.err());
      assert.match(t.err(), re);
    });
  }

  it('a name only an object inherits is an unknown command (exit 1), not a crash', async () => {
    for (const name of ['toString', 'constructor', '__proto__']) {
      const t = io();
      assert.strictEqual(await main([name, '--remote', '1', ...SIGNED], t), 1, t.err());
      assert.match(t.err(), new RegExp(`^unknown command ${name}\\n`));
    }
  });

  it('an option the command takes is not refused (enable --remote reaches the key)', async () => {
    const t = io();
    assert.strictEqual(await main(['enable', 'gw-1', 'com.example/srv', '1.0.0', '--remote', '1', ...SIGNED], t), 1);
    assert.match(t.err(), /cannot read the key file \/nonexistent/);
  });
});
