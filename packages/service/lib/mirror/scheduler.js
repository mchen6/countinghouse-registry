'use strict';
// When the mirror runs (spec section 6.1, 6.6): at start, then every
// upstream.intervalMinutes; the run is a reconciliation pass when the UTC hour is
// upstream.reconcile.atHour and at least everyDays (less an hour of slack) have
// passed since the last full pass. One run at a time; stop() asks the current run
// to stop after the page it is applying, and waits for it.
const {runSync} = require('./sync');

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

function createScheduler({store, client, log, config, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout,
  run = (opts) => runSync(store, client, log, opts)}) {
  const intervalMs = config.upstream.intervalMinutes * 60000;
  const {everyDays, atHour} = config.upstream.reconcile;
  let current = null;
  let timer = null;
  let stopped = false;

  async function chooseMode() {
    const [st] = await store.read('SELECT first_sync_done, last_reconcile_at FROM mirror_state WHERE id = 1');
    if (!st.first_sync_done) return 'first';
    const t = now();
    const last = st.last_reconcile_at ? Date.parse(st.last_reconcile_at) : 0;
    if (t.getUTCHours() === atHour && t.getTime() - last >= everyDays * DAY_MS - HOUR_MS) return 'reconcile';
    return 'incremental';
  }

  function schedule() {
    if (!stopped) timer = setTimer(() => { timer = null; runNow(); }, intervalMs);
  }

  function runNow() {
    if (current || stopped) return {started: false};
    if (timer) { clearTimer(timer); timer = null; }
    current = chooseMode()
      .then((mode) => run({mode, now, shouldStop: () => stopped}))
      .catch((err) => log.error('mirror.run.error', 'a mirror run threw', {code: err.code || err.name}))
      .then(() => { current = null; schedule(); });
    return {started: true};
  }

  return {
    start: () => { runNow(); },
    runNow,
    stop: async () => {
      stopped = true;
      if (timer) { clearTimer(timer); timer = null; }
      if (current) await current;
    }
  };
}

module.exports = {createScheduler};
