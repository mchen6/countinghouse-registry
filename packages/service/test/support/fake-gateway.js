'use strict';
// A fake countinghouse gateway instance (R1's side of spec 9.4), in process: it
// polls its enabled list every `intervalMs` with the last nextSince, and for each
// entry in state `requested` posts `validated` with the tools its listed server
// answers (toolsFor(name, version)). It never retries on its own beyond the next
// poll, and stops on stop().
function createFakeGateway({call, X, instance, token, toolsFor, intervalMs = 50}) {
  let since;
  let timer = null;
  let stopped = false;
  let running = Promise.resolve();
  const seen = [];

  async function once() {
    const q = since === undefined ? '' : `?since=${since}`;
    const res = await call('GET', `${X}/instances/${instance}/enabled${q}`, token());
    if (res.status !== 200) return;
    for (const item of res.body.items) {
      seen.push(item);
      if (item.state === 'requested') {
        await call('POST', `${X}/instances/${instance}/results`, token(), {name: item.name, version: item.version, outcome: 'validated', tools: toolsFor(item.name, item.version)});
      }
    }
    since = res.body.nextSince;
  }

  const tick = () => {
    if (stopped) return;
    running = once().catch(() => {}).then(() => { if (!stopped) timer = setTimeout(tick, intervalMs); });
  };

  return {
    start: () => { tick(); },
    stop: async () => { stopped = true; if (timer) clearTimeout(timer); await running; },
    seen
  };
}

module.exports = {createFakeGateway};
