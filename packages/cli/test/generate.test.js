'use strict';
// generate (spec 11.4) over a copy of the fixture module, with countinghouse-validate
// and the tool-list export faked (the interim fixtures, spec 15), and the defaults
// run for real against a stub countinghouse install.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const {generate, repositoryOf} = require('../lib/commands/generate');
const {validateServerJson, CURRENT_SCHEMA} = require('../lib/validate');
const {recordHash, validateRecord} = require('../lib/record');
const {moduleCopy, fakeExec, validateOk, fixtureTools, ECHO_TOOLS} = require('./support/module');

const REGISTRY = 'https://registry.example.org';
const BIN = path.join(__dirname, '..', 'bin', 'countinghouse-registry-cli.js');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('generate', () => {
  let m;
  afterEach(() => { if (m) m.remove(); m = null; });

  const run = (opts = {}) => generate({dir: m.dir, registry: REGISTRY, exec: validateOk().exec, toolsList: fixtureTools, ...opts});
  const fails = async (promise, exitCode, re) => {
    await assert.rejects(promise, (err) => {
      assert.strictEqual(err.exitCode, exitCode, err.message);
      assert.match(err.message, re);
      return true;
    });
  };

  it('emits server.json exactly as spec 11.4', async () => {
    m = moduleCopy();
    const out = await run();
    assert.strictEqual(out.serverJsonPath, path.join(m.dir, 'server.json'));
    assert.deepStrictEqual(readJson(out.serverJsonPath), {
      $schema: CURRENT_SCHEMA,
      name: 'com.example/echo',
      description: 'Echoes text back: a minimal countinghouse module',
      version: '1.0.0',
      repository: {url: 'https://github.com/example/countinghouse-module-echo', source: 'github', subfolder: 'modules/echo'},
      websiteUrl: 'https://github.com/example/countinghouse-module-echo',
      packages: [{
        registryType: 'npm',
        identifier: 'countinghouse-module-echo',
        version: '1.0.0',
        runtimeHint: 'npx',
        transport: {
          type: 'streamable-http',
          url: 'http://{host}:{port}/mcp',
          headers: [{name: 'X-CH-Key', description: 'The countinghouse API key: the demo key the module prints on first start, or the value of COUNTINGHOUSE_API_KEY', isRequired: true, isSecret: true}]
        },
        packageArguments: [
          {type: 'named', name: '--port', description: 'TCP port the /mcp endpoint listens on', valueHint: 'port', format: 'number', default: '9527'},
          {type: 'named', name: '--bindAddr', description: 'Address the /mcp endpoint binds to', valueHint: 'host', default: '127.0.0.1'}
        ],
        environmentVariables: [{name: 'COUNTINGHOUSE_API_KEY', description: 'Runs the module with this single API key instead of a demo key; send the same value as the X-CH-Key header', isRequired: false, isSecret: true}]
      }],
      _meta: {'io.modelcontextprotocol.registry/publisher-provided': {'io.github.mchen6.countinghouse': {
        record: `${REGISTRY}/v0.1/x/io.github.mchen6/countinghouse-registry/records/com.example%2Fecho/versions/1.0.0`,
        sha256: out.sha256,
        recordVersion: 1
      }}}
    });
  });

  it('writes countinghouse-record.json whose hash equals the pointer', async () => {
    m = moduleCopy();
    const out = await run();
    const record = readJson(out.recordPath);
    assert.deepStrictEqual(record, {recordVersion: 1, countinghouse: '^8', tools: ECHO_TOOLS.tools, calls: ['log-read/readService.list'], permissions: {}});
    assert.ok(validateRecord(record).valid);
    assert.strictEqual(recordHash(record), out.sha256);
    const pointer = readJson(out.serverJsonPath)._meta['io.modelcontextprotocol.registry/publisher-provided']['io.github.mchen6.countinghouse'];
    assert.strictEqual(pointer.sha256, out.sha256);
  });

  it('carries the declared permissions, and a registry URL with a trailing slash', async () => {
    m = moduleCopy({pkg: (p) => ({...p, countinghouse: {permissions: {readFile: ['/data']}}})});
    const out = await run({registry: `${REGISTRY}/`});
    const record = readJson(out.recordPath);
    assert.deepStrictEqual([record.calls, record.permissions], [[], {readFile: ['/data']}]);
    const pointer = readJson(out.serverJsonPath)._meta['io.modelcontextprotocol.registry/publisher-provided']['io.github.mchen6.countinghouse'];
    assert.ok(pointer.record.startsWith(`${REGISTRY}/v0.1/x/`), pointer.record);
  });

  it('the emitted server.json passes validateServerJson', async () => {
    m = moduleCopy();
    const out = await run();
    const result = validateServerJson(readJson(out.serverJsonPath));
    assert.deepStrictEqual(result.issues, []);
    assert.strictEqual(result.valid, true);
  });

  it('runs the module\'s own countinghouse-validate --json on the directory', async () => {
    m = moduleCopy();
    const v = validateOk();
    await run({exec: v.exec});
    assert.strictEqual(v.calls.length, 1);
    assert.strictEqual(v.calls[0].file, process.execPath);
    assert.deepStrictEqual(v.calls[0].args, [path.join(m.dir, 'node_modules', 'countinghouse', 'bin', 'countinghouse-validate.js'), '--json', m.dir]);
  });

  it('exit 1 on validate problems, listing them', async () => {
    m = moduleCopy();
    const report = {ok: false, module: 'echo', problems: [{stage: 'schema', message: 'EchoInput is not defined', fix: 'add EchoInput to schema.json'}, {stage: 'handlers', message: 'echo.echo has no handler'}], warnings: []};
    const v = fakeExec({stdout: `noise from the module\n${JSON.stringify(report)}\n`, code: 1});
    await fails(run({exec: v.exec}), 1, /\[schema\] EchoInput is not defined[\s\S]*fix: add EchoInput to schema\.json[\s\S]*\[handlers\] echo\.echo has no handler/);
    assert.ok(!fs.existsSync(path.join(m.dir, 'server.json')));
  });

  it('exit 2 when countinghouse is not resolvable', async () => {
    m = moduleCopy({countinghouse: false});
    await fails(run(), 2, /countinghouse cannot be resolved from .*: install it as a devDependency/);
  });

  it('exit 2 when countinghouse-validate cannot look at the directory', async () => {
    m = moduleCopy();
    await fails(run({exec: fakeExec({stdout: '{"error":"no api.json"}\n', code: 2}).exec}), 2, /countinghouse-validate could not check .*: no api\.json/);
  });

  it('exit 2 naming the step when a child is killed or overflows', async () => {
    m = moduleCopy();
    const killed = fakeExec({error: Object.assign(new Error('killed'), {code: null, signal: 'SIGKILL'})});
    await fails(run({exec: killed.exec}), 2, /^countinghouse-validate could not run: killed by SIGKILL$/);
    const big = fakeExec({error: Object.assign(new Error('maxBuffer'), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'})});
    await fails(run({exec: big.exec}), 2, /^countinghouse-validate could not run: ERR_CHILD_PROCESS_STDIO_MAXBUFFER$/);
  });

  it('a child that does not finish in time is told so, by the limit', async () => {
    m = moduleCopy();
    const slow = fakeExec({error: Object.assign(new Error('timed out'), {code: null, killed: true, signal: 'SIGKILL'})});
    await fails(run({exec: slow.exec}), 2, /^countinghouse-validate did not finish within 5 minutes and was stopped$/);
    assert.strictEqual(slow.calls[0].opts.killSignal, 'SIGKILL');
  });

  it('accepts npm\'s string shorthand for bin', async () => {
    m = moduleCopy({pkg: (p) => ({...p, bin: './bin/countinghouse-launch.js'})});
    const out = await run();
    assert.strictEqual(readJson(out.serverJsonPath).packages[0].identifier, readJson(path.join(m.dir, 'package.json')).name);
  });

  describe('repositoryOf', () => {
    const ok = (repo, url, source = 'github') => assert.deepStrictEqual(repositoryOf(repo), {value: {url, source}}, JSON.stringify(repo));
    it('accepts the scp form npm documents, http, git+ssh and the shorthands, as https', () => {
      ok('git@github.com:owner/repo.git', 'https://github.com/owner/repo');
      ok({type: 'git', url: 'git+ssh://git@github.com/owner/repo.git'}, 'https://github.com/owner/repo');
      ok('http://github.com/owner/repo', 'https://github.com/owner/repo');
      ok({url: 'git@gitlab.com:group/sub/repo.git'}, 'https://gitlab.com/group/sub/repo', 'gitlab');
      ok('github:owner/repo', 'https://github.com/owner/repo');
      ok('owner/repo', 'https://github.com/owner/repo');
      ok('https://github.com/owner/repo.git/', 'https://github.com/owner/repo');
    });
    it('refuses a deeper path in package.json\'s terms, pointing to directory', () => {
      for (const url of ['https://github.com/o/r/tree/main/sub', 'https://gitlab.com/g/r/-/tree/main', 'https://gitlab.com/g/r/-/']) {
        const {problem} = repositoryOf({url});
        const host = url.includes('gitlab') ? 'gitlab' : 'github';
        assert.strictEqual(problem, `repository ${url} in package.json must name the repository itself (https://${host}.com/owner/repo); use repository.directory for a subfolder`);
      }
    });
    it('a deeper path fails as a package.json problem, before any server.json is generated', async () => {
      m = moduleCopy({pkg: (p) => ({...p, repository: {type: 'git', url: 'https://github.com/o/r/tree/main/sub'}})});
      await fails(run(), 1, /^package\.json in .* needs changes before generate:\n {2}repository .* must name the repository itself/);
    });
  });

  it('exit 1 for a description over 100 characters; no truncation', async () => {
    m = moduleCopy({pkg: (p) => ({...p, description: 'x'.repeat(101)})});
    await fails(run(), 1, /description is 101 characters; the registry allows 100: shorten it in package\.json/);
    assert.ok(!fs.existsSync(path.join(m.dir, 'server.json')));
  });

  it('exit 1 for a missing description', async () => {
    m = moduleCopy({pkg: ({description, ...p}) => p});
    await fails(run(), 1, /add a description \(at most 100 characters\) to package\.json/);
  });

  it('exit 1 for a non-strict version', async () => {
    m = moduleCopy({pkg: (p) => ({...p, version: '1.0'})});
    await fails(run(), 1, /version 1\.0 is not strict semver/);
  });

  it('exit 1 for a missing or invalid mcpName', async () => {
    m = moduleCopy({pkg: ({mcpName, ...p}) => p});
    await fails(run(), 1, /add mcpName/);
    m.remove();
    m = moduleCopy({pkg: (p) => ({...p, mcpName: 'no-slash'})});
    await fails(run(), 1, /mcpName no-slash is not valid/);
  });

  it('exit 1 for a package shape other than 11.1, listing every problem', async () => {
    m = moduleCopy({pkg: ({repository, peerDependencies, ...p}) => ({...p, bin: {other: './bin/other.js'}, files: ['api.json']})});
    await fails(run(), 1, /bin[\s\S]*files[\s\S]*repository[\s\S]*peerDependencies\.countinghouse/);
  });

  it('exit 1 with the capture instruction on MODULE_DISCOVERS_DEVICES', async () => {
    m = moduleCopy();
    const toolsList = async () => { throw Object.assign(new Error('the module discovers devices at run time'), {code: 'MODULE_DISCOVERS_DEVICES'}); };
    await fails(run({toolsList}), 1, /discovers its devices at run time[\s\S]*run the capture against a server/);
    assert.ok(!fs.existsSync(path.join(m.dir, 'countinghouse-record.json')));
  });

  it('exit 1 when the tool list does not make a valid record', async () => {
    m = moduleCopy();
    await fails(run({toolsList: async () => ({tools: [{name: 'echo'}]})}), 1, /the tool list does not make a valid record[\s\S]*inputSchema/);
  });

  describe('the defaults, run for real against a stub countinghouse', () => {
    const stub = (rel, body) => {
      const file = path.join(m.dir, 'node_modules', 'countinghouse', rel);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, body);
    };

    it('runs countinghouse-validate and the export in child node processes in the module directory', async () => {
      m = moduleCopy();
      stub('bin/countinghouse-validate.js', `console.log(JSON.stringify({ok: process.argv[2] === '--json' && process.argv[3] === ${JSON.stringify(m.dir)}, module: 'echo', problems: [{stage: 'args', message: 'unexpected arguments'}]}));\n`);
      stub('lib/mcp/tools-list-for-module.js', `console.log('a stray line');\nexports.toolsListForModule = (dir) => ({tools: [{name: 'echo.echo', description: process.cwd() === dir ? 'cwd ok' : 'cwd wrong', inputSchema: {type: 'object'}}]});\n`);
      const out = await generate({dir: m.dir, registry: REGISTRY});
      assert.strictEqual(readJson(out.recordPath).tools[0].description, 'cwd ok');
    });

    it('carries MODULE_DISCOVERS_DEVICES from the child', async () => {
      m = moduleCopy();
      stub('bin/countinghouse-validate.js', 'console.log(JSON.stringify({ok: true, module: "echo", problems: []}));\n');
      stub('lib/mcp/tools-list-for-module.js', 'exports.toolsListForModule = async () => { throw Object.assign(new Error("discovers"), {code: "MODULE_DISCOVERS_DEVICES"}); };\n');
      await fails(generate({dir: m.dir, registry: REGISTRY}), 1, /run the capture against a server/);
    });

    it('the tool-list child exits even when the module leaves a handle open', async function () {
      this.timeout(10000);
      m = moduleCopy();
      stub('bin/countinghouse-validate.js', 'console.log(JSON.stringify({ok: true, module: "echo", problems: []}));\n');
      stub('lib/mcp/tools-list-for-module.js', 'setInterval(() => {}, 1000);\nexports.toolsListForModule = () => ({tools: [{name: "echo.echo", inputSchema: {}}]});\n');
      const out = await generate({dir: m.dir, registry: REGISTRY});
      assert.strictEqual(readJson(out.recordPath).tools[0].name, 'echo.echo');
    });

    it('a tool-list module that fails to load is reported as that, not as a missing export', async () => {
      m = moduleCopy();
      stub('bin/countinghouse-validate.js', 'console.log(JSON.stringify({ok: true, module: "echo", problems: []}));\n');
      stub('lib/mcp/tools-list-for-module.js', 'require("a-missing-nested-dependency");\n');
      await assert.rejects(generate({dir: m.dir, registry: REGISTRY}), (err) => {
        assert.strictEqual(err.exitCode, 2);
        assert.match(err.message, /^countinghouse's lib\/mcp\/tools-list-for-module failed to load: Cannot find module 'a-missing-nested-dependency'$/);
        return true;
      });
      stub('lib/mcp/tools-list-for-module.js', 'throw new Error("boom at load");\n');
      await fails(generate({dir: m.dir, registry: REGISTRY}), 2, /^countinghouse's lib\/mcp\/tools-list-for-module failed to load: boom at load$/);
    });

    it('a child that ignores SIGTERM and stays open is stopped at the limit', async function () {
      this.timeout(8000);
      m = moduleCopy();
      // Ignores SIGTERM, keeps a handle open, and gives up by itself after 6 s.
      stub('bin/countinghouse-validate.js', 'process.on("SIGTERM", () => {});\nsetTimeout(() => process.exit(0), 6000);\n');
      await fails(generate({dir: m.dir, registry: REGISTRY, childTimeoutMs: 300}), 2, /^countinghouse-validate did not finish within 0\.3 seconds and was stopped$/);
    });

    it('exit 2 when the installed countinghouse has no toolsListForModule', async () => {
      m = moduleCopy();
      stub('bin/countinghouse-validate.js', 'console.log(JSON.stringify({ok: true, module: "echo", problems: []}));\n');
      await fails(generate({dir: m.dir, registry: REGISTRY}), 2, /has no lib\/mcp\/tools-list-for-module/);
    });
  });

  describe('the bin', () => {
    it('exit 2 and the reason when countinghouse is not resolvable', () => {
      m = moduleCopy({countinghouse: false});
      const r = spawnSync(process.execPath, [BIN, 'generate', m.dir, '--registry', REGISTRY], {encoding: 'utf8'});
      assert.strictEqual(r.status, 2, r.stderr);
      assert.match(r.stderr, /countinghouse cannot be resolved/);
    });

    it('exit 1 for an unknown command, with the usage', () => {
      const r = spawnSync(process.execPath, [BIN, 'frobnicate'], {encoding: 'utf8'});
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /unknown command frobnicate[\s\S]*usage: countinghouse-registry-cli/);
    });

    it('--help prints the usage to stdout and exits 0; no command is exit 1', () => {
      const help = spawnSync(process.execPath, [BIN, '--help'], {encoding: 'utf8'});
      assert.strictEqual(help.status, 0);
      assert.match(help.stdout, /^usage: countinghouse-registry-cli/);
      const none = spawnSync(process.execPath, [BIN], {encoding: 'utf8'});
      assert.strictEqual(none.status, 1);
      assert.match(none.stderr, /^usage: countinghouse-registry-cli/);
    });

    it('exit 1 when generate is missing --registry', () => {
      m = moduleCopy();
      const r = spawnSync(process.execPath, [BIN, 'generate', m.dir], {encoding: 'utf8'});
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /generate needs --registry/);
    });
  });
});
