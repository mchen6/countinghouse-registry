'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {openStore} = require('../lib/store');
const {createLogger} = require('../lib/log');
const {createScheduler} = require('../lib/mirror/scheduler');

const CONFIG = {upstream: {url: 'https://registry.example', intervalMinutes: 60, reconcile: {everyDays: 7, atHour: 3}}};

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

  const make = () => createScheduler({store, log, config: CONFIG, now, setTimer, clearTimer, run});
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
    await store.write((tx) => tx.run("UPDATE mirror_state SET first_sync_done = 1, last_reconcile_at = '2026-11-03T03:10:00.000Z' WHERE id = 1"));
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
    await store.write((tx) => tx.run("UPDATE mirror_state SET last_reconcile_at = '2026-11-10T03:05:00.000Z' WHERE id = 1"));
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
    const s = createScheduler({store, log: createLogger({stream: {write: (l) => { lines.push(l); return true; }}}), config: CONFIG, now, setTimer, clearTimer,
      run: () => Promise.reject(Object.assign(new Error('disk'), {code: 'SQLITE_FULL'}))});
    s.start();
    await until(() => timers.length === 1);
    assert.ok(lines.some((l) => JSON.parse(l).event === 'mirror.run.error'));
    await s.stop();
  });
});
