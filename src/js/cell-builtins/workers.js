// worker(fn) / workerPool(fn, n) — offload pure computation to Web Workers.
// Function is serialized as source (closures stripped); zero-copy transfer
// of TypedArray buffers in arguments and results.

export function makeWorker(cell, ctx) {
  const { invalidation } = ctx;

  return function worker(fn) {
    const src = `"use strict";\nconst __fn__ = ${fn.toString()};\nonmessage = async (e) => {\n  try {\n    const result = await __fn__(...e.data.args);\n    const transfer = [];\n    if (result instanceof ArrayBuffer) transfer.push(result);\n    else if (result?.buffer instanceof ArrayBuffer) transfer.push(result.buffer);\n    postMessage({ result }, transfer);\n  } catch (err) { postMessage({ error: err.message }); }\n};`;
    const blob = new Blob([src], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    invalidation.then(() => w.terminate());

    const call = (...args) => new Promise((resolve, reject) => {
      w.onmessage = (e) => e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result);
      w.onerror = (e) => reject(new Error(e.message));
      const transfer = [];
      for (const a of args) {
        if (a instanceof ArrayBuffer) transfer.push(a);
        else if (a?.buffer instanceof ArrayBuffer) transfer.push(a.buffer);
      }
      w.postMessage({ args }, transfer);
    });
    call.terminate = () => w.terminate();
    return call;
  };
}

export function makeWorkerPool(cell, ctx) {
  const worker = makeWorker(cell, ctx);

  return function workerPool(fn, n = navigator.hardwareConcurrency || 4) {
    const workers = Array.from({ length: n }, () => worker(fn));
    const free = [...workers];
    const queue = [];

    const dispatch = () => {
      while (queue.length && free.length) {
        const { args, resolve, reject } = queue.shift();
        const w = free.shift();
        w(...args).then(
          r => { free.push(w); resolve(r); dispatch(); },
          e => { free.push(w); reject(e); dispatch(); }
        );
      }
    };

    const pool = (...args) => new Promise((resolve, reject) => {
      queue.push({ args, resolve, reject });
      dispatch();
    });
    pool.map = (arr, ...extra) => Promise.all(arr.map(item => pool(item, ...extra)));
    pool.terminate = () => workers.forEach(w => w.terminate());
    return pool;
  };
}
