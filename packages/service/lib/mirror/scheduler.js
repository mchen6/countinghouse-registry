'use strict';
// When the mirror runs (spec section 6.1, 6.6): at start, then every
// upstream.intervalMinutes. A run is a reconciliation pass once the reconcile slot
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

function createScheduler({store, client, log, config, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout,
  run = (opts) => runSync(store, client, log, opts)}) {
  const intervalMs = config.upstream.intervalMinutes * 60000;
  const {everyDays, atHour} = config.upstream.reconcile;
  const abort = new AbortController();
  let current = null;
  let timer = null;

  async function chooseMode() {
    const [st] = await store.read('SELECT first_sync_done, last_reconcile_at FROM mirror_state WHERE id = 1');
    if (!st.first_sync_done) return 'first';
    const [retry] = await store.read("SELECT v FROM meta_kv WHERE k = 'mirror_reconcile_retry_at'");
    const t = now().getTime();
    if (retry) return t >= Date.parse(retry.v) ? 'reconcile' : 'incremental';
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
      .then((mode) => run({mode, now, atHour, signal: abort.signal, shouldStop: () => abort.signal.aborted}))
      .catch((err) => log.error('mirror.run.error', 'a mirror run threw', {code: err.code || err.name}))
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

module.exports = {createScheduler, reconcileSlot};
