'use strict';
// When an upstream is mirrored (spec section 6.1, 6.6, 6.8): at start, then every
// intervalMinutes of that upstream; createMirror runs one scheduler per upstream. A run is a reconciliation pass once the reconcile slot
// has come: the UTC hour atHour on the day everyDays after the last pass's day.
// Any run that starts at or after the slot reconciles, so a slot is never skipped
// by the interval's drift. After an upstream-shrank pass the next try is the next
// day's slot. One run at a time; stop() aborts the run's waits and fetches,
// lets the page being applied finish, and waits for it.
const {runSync} = require('./sync');

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

function reconcileSlot(lastIso, everyDays, atHour) {
  const last = new Date(lastIso);
  const day = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  return day + everyDays * DAY_MS + atHour * HOUR_MS;
}

function createScheduler({store, client, log, upstream, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout,
  run = (opts) => runSync(store, opts.client, log, opts)}) {
  const intervalMs = upstream.intervalMinutes * 60000;
  const {everyDays, atHour} = upstream.reconcile;
  const abort = new AbortController();
  let current = null;
  let timer = null;

  async function chooseMode() {
    const [st] = await store.read('SELECT first_sync_done, last_reconcile_at, reconcile_retry_at FROM mirror_upstreams WHERE name = ?', [upstream.name]);
    if (!st.first_sync_done) return 'first';
    const t = now().getTime();
    if (st.reconcile_retry_at) return t >= Date.parse(st.reconcile_retry_at) ? 'reconcile' : 'incremental';
    if (!st.last_reconcile_at) return 'incremental';
    return t >= reconcileSlot(st.last_reconcile_at, everyDays, atHour) ? 'reconcile' : 'incremental';
  }

  function schedule() {
    if (!abort.signal.aborted) timer = setTimer(() => { timer = null; runNow(); }, intervalMs);
  }

  function runNow() {
    if (current || abort.signal.aborted) return {started: false};
    if (timer) { clearTimer(timer); timer = null; }
    current = chooseMode()
      .then((mode) => run({upstream: upstream.name, client, mode, now, atHour, signal: abort.signal, shouldStop: () => abort.signal.aborted}))
      .catch((err) => log.error('mirror.run.error', 'a mirror run threw', {upstream: upstream.name, code: err.code || err.name}))
      .then(() => { current = null; schedule(); });
    return {started: true};
  }

  return {
    start: () => { runNow(); },
    runNow,
    stop: async () => {
      abort.abort();
      if (timer) { clearTimer(timer); timer = null; }
      if (current) await current;
    }
  };
}

// One scheduler per configured upstream. runNow(name) starts that upstream's run;
// runNow() starts every upstream not already running, and says whether any started.
function createMirror({store, log, config, clientFor, ...rest}) {
  const schedulers = new Map(config.upstreams.map((u) => [u.name, createScheduler({store, log, upstream: u, client: clientFor(u), ...rest})]));
  return {
    start: () => { for (const s of schedulers.values()) s.start(); },
    runNow: (name) => {
      if (name !== undefined) return schedulers.has(name) ? schedulers.get(name).runNow() : {started: false};
      let started = false;
      for (const s of schedulers.values()) started = s.runNow().started || started;
      return {started};
    },
    stop: () => Promise.all([...schedulers.values()].map((s) => s.stop())).then(() => {})
  };
}

module.exports = {createScheduler, createMirror, reconcileSlot};
