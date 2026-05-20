// @gcu/abus — a peer that lives in a Web Worker.
//
// The parent (smoke.html) transfers a MessagePort in via worker.postMessage;
// this peer adopts it and joins the bus. A Worker has no realm-confusion
// risk — its only postMessage source is the page that created it — so no
// abus:welcome origin check is needed (unlike the iframe peer).

import { connect } from './src/main.js';

self.addEventListener('message', async (ev) => {
  if (!ev.data || ev.data.type !== 'abus:welcome') return;

  const bus = await connect(ev.data.port, { client: 'worker-peer' });
  bus.expose('/calc', {
    Calc: { methods: { Mul: (a, b) => a * b } },
  });
  await bus.claim('worker-peer');
  self.postMessage({ type: 'abus:peer-ready' });
});
