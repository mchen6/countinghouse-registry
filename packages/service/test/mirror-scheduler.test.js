'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {openStore} = require('../lib/store');
const {createLogger} = require('../lib/log');
const {createScheduler, createMirror} = require('../lib/mirror/scheduler');
const {applyUpstreams} = require('../lib/mirror/sources');

const UPSTREAM = {name: 'official', url: 'https://registry.example', intervalMinutes: 60, reconcile: {everyDays: 7, atHour: 3}};

describe('mirror scheduler', () => {
  let dir;
  let store;
  let timers;
  let clock;
  let runs;
  let release;
  const log = createLogger({stream: {write: () => true}});
  const now = () => new Date(clock);
  const setTimer = (fn, ms) => { const t = {fn, ms}; timers.push(t); return t; };
  const clearTimer = (t) => { timers = timers.filter((x) => x !== t); };
  // A run that finishes when the test releases it, recording the mode and honouring shouldStop.
  const run = (opts) => new Promise((resolve) => {
    runs.push(opts);
    release = () => resolve({state: 'idle'});
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-sched-'));
    store = await openStore(path.join(dir, 'r.db'));
    timers = [];
    runs = [];
    clock = Date.parse('2026-11-10T10:00:00.000Z');
  });
  afterEach(async () => { await store.close(); fs.rmSync(dir, {recursive: true, force: true}); });

  const make = () => createScheduler({store, log, upstream: UPSTREAM, now, setTimer, clearTimer, run});
  const tick = () => new Promise((r) => setTimeout(r, 5));
  // Waits until cond() holds (the scheduler's store read runs on sqlite's thread pool).
  const until = async (cond) => { for (let i = 0; i < 400 && !cond(); i++) await tick(); assert.ok(cond(), 'condition never held'); };

  it('runs at start and then every intervalMinutes', async () => {
    const s = make();
    s.start();
    await until(() => runs.length === 1);
    release();
    await until(() => timers.length === 1);
    assert.strictEqual(timers[0].ms, 60 * 60000);
    const t = timers.shift();
    t.fn();
    await until(() => runs.length === 2);
    release();
    await s.stop();
  });

  it('refuses a second concurrent run', async () => {
    const s = make();
    assert.deepStrictEqual(s.runNow(), {started: true});
    assert.deepStrictEqual(s.runNow(), {started: false});
    await until(() => runs.length === 1);
    assert.deepStrictEqual(s.runNow(), {started: false});
    release();
    await until(() => timers.length === 1);
    assert.deepStrictEqual(s.runNow(), {started: true});
    await until(() => runs.length === 2);
    release();
    await s.stop();
  });

  it('runs reconcile at atHour once everyDays have passed since the last pass', async () => {
    await store.write((tx) => tx.run("UPDATE mirror_upstreams SET first_sync_done = 1, last_reconcile_at = '2026-11-03T03:10:00.000Z' WHERE name = 'official'"));
    const s = make();
    clock = Date.parse('2026-11-10T02:30:00.000Z');
    s.runNow();
    await until(() => runs.length === 1);
    assert.strictEqual(runs[0].mode, 'incremental', 'reconciled before atHour');
    release();
    await until(() => timers.length === 1);
    clock = Date.parse('2026-11-10T03:05:00.000Z');
    s.runNow();
    await until(() => runs.length === 2);
    assert.strictEqual(runs[1].mode, 'reconcile');
    release();
    await until(() => timers.length === 1);
    await store.write((tx) => tx.run("UPDATE mirror_upstreams SET last_reconcile_at = '2026-11-10T03:05:00.000Z' WHERE name = 'official'"));
    clock = Date.parse('2026-11-11T03:05:00.000Z');
    s.runNow();
    await until(() => runs.length === 3);
    assert.strictEqual(runs[2].mode, 'incremental', 'reconciled again before everyDays');
    release();
    await s.stop();
  });

  it('stop waits for the page being applied, then resolves', async () => {
    const s = make();
    s.start();
    await until(() => runs.length === 1);
    let stopped = false;
    const p = s.stop().then(() => { stopped = true; });
    await tick();
    assert.strictEqual(runs[0].shouldStop(), true, 'the run was not asked to stop');
    assert.strictEqual(stopped, false, 'stop resolved before the run finished');
    release();
    await p;
    assert.strictEqual(stopped, true);
    assert.strictEqual(timers.length, 0, 'a timer survived stop');
  });

  it('a run that throws is logged and the next one is still scheduled', async () => {
    const lines = [];
    const s = createScheduler({store, log: createLogger({stream: {write: (l) => { lines.push(l); return true; }}}), upstream: UPSTREAM, now, setTimer, clearTimer,
      run: () => Promise.reject(Object.assign(new Error('disk'), {code: 'SQLITE_FULL'}))});
    s.start();
    await until(() => timers.length === 1);
    assert.ok(lines.some((l) => JSON.parse(l).event === 'mirror.run.error'));
    await s.stop();
  });

  const modeAt = async (iso, lastReconcile, extra = '') => {
    await store.write((tx) => tx.run(`UPDATE mirror_upstreams SET first_sync_done = 1, last_reconcile_at = ? WHERE name = 'official'`, [lastReconcile]));
    if (extra) await store.write((tx) => tx.run(extra));
    clock = Date.parse(iso);
    const s = make();
    s.runNow();
    await until(() => runs.length > 0);
    const m = runs[runs.length - 1].mode;
    release();
    await until(() => timers.length === 1);
    await s.stop();
    runs.length = 0;
    timers = [];
    return m;
  };

  it('a reconcile due at atHour still runs when the first run after it starts later', async () => {
    assert.strictEqual(await modeAt('2026-11-10T04:00:00.000Z', '2026-11-03T03:10:00.000Z'), 'reconcile');
    assert.strictEqual(await modeAt('2026-11-12T17:00:00.000Z', '2026-11-03T03:10:00.000Z'), 'reconcile');
  });

  it('the first reconcile comes everyDays after the first sync, at atHour', async () => {
    assert.strictEqual(await modeAt('2026-11-17T02:59:00.000Z', '2026-11-10T10:00:00.000Z'), 'incremental');
    assert.strictEqual(await modeAt('2026-11-17T03:00:00.000Z', '2026-11-10T10:00:00.000Z'), 'reconcile');
  });

  it('after an upstream-shrank pass, reconcile is retried the next day, not within the hour', async () => {
    const shrank = "UPDATE mirror_upstreams SET reconcile_retry_at = '2026-11-11T03:00:00.000Z' WHERE name = 'official'";
    assert.strictEqual(await modeAt('2026-11-10T03:30:00.000Z', '2026-11-03T03:10:00.000Z', shrank), 'incremental');
    assert.strictEqual(await modeAt('2026-11-11T03:10:00.000Z', '2026-11-03T03:10:00.000Z'), 'reconcile');
  });

  it("passes the upstream's name to its runs", async () => {
    const s = make();
    s.start();
    await until(() => runs.length === 1);
    assert.strictEqual(runs[0].upstream, 'official');
    release();
    await s.stop();
  });

  describe('createMirror', () => {
    const B = {name: 'own', url: 'https://own.example', intervalMinutes: 10, reconcile: {everyDays: 1, atHour: 0}};
    let pending;
    const runEach = (opts) => new Promise((resolve) => { runs.push(opts); pending.push(() => resolve({state: 'idle'})); });
    beforeEach(async () => {
      pending = [];
      await applyUpstreams(store, [UPSTREAM, B], now().toISOString());
    });
    const mirror = () => createMirror({store, log, config: {upstreams: [UPSTREAM, B]}, clientFor: (u) => ({name: u.name}),
      now, setTimer, clearTimer, run: runEach});

    it('runs every upstream at start, each with its own client and interval', async () => {
      const m = mirror();
      m.start();
      await until(() => runs.length === 2);
      assert.deepStrictEqual(runs.map((r) => [r.upstream, r.client.name]).sort(), [['official', 'official'], ['own', 'own']]);
      pending.splice(0).forEach((f) => f());
      await until(() => timers.length === 2);
      assert.deepStrictEqual(timers.map((t) => t.ms).sort((x, y) => x - y), [10 * 60000, 60 * 60000]);
      await m.stop();
    });

    it('runNow(name) starts that upstream only; runNow() starts every idle one', async () => {
      const m = mirror();
      assert.deepStrictEqual(m.runNow('own'), {started: true});
      await until(() => runs.length === 1);
      assert.strictEqual(runs[0].upstream, 'own');
      assert.deepStrictEqual(m.runNow('own'), {started: false});
      assert.deepStrictEqual(m.runNow(), {started: true});
      await until(() => runs.length === 2);
      assert.strictEqual(runs[1].upstream, 'official');
      assert.deepStrictEqual(m.runNow('nope'), {started: false});
      pending.splice(0).forEach((f) => f());
      await m.stop();
    });

    it('stop stops every upstream', async () => {
      const m = mirror();
      m.start();
      await until(() => runs.length === 2);
      const p = m.stop();
      assert.ok(runs.every((r) => r.signal.aborted));
      pending.splice(0).forEach((f) => f());
      await p;
    });
  });

  it('stop aborts the run it waits for', async () => {
    const s = make();
    s.start();
    await until(() => runs.length === 1);
    const p = s.stop();
    assert.strictEqual(runs[0].signal.aborted, true);
    release();
    await p;
  });
});
