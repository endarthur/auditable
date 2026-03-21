// mpy tagged template + self-registration

import { initInterpreter, flushStdout } from './init.js';

export async function mpy(strings, ...values) {
  const mp = await initInterpreter();

  flushStdout(); // drain stale output

  // build code with _v0, _v1 placeholders, inject values via Python
  mp.runPython('_adder_ns = {}');
  let code = strings[0];
  for (let i = 0; i < values.length; i++) {
    const key = '_v' + i;
    mp.globals.set('_adder_inject_v', values[i]);
    mp.runPython(`_adder_ns["${key}"] = _adder_inject_v`);
    code += key + strings[i + 1];
  }
  try { mp.globals.delete('_adder_inject_v'); } catch {}

  // execute
  mp.globals.set('_adder_code', code);
  mp.runPython('_exec_cell(_adder_code, _adder_ns)');

  // extract results — get keys as JSON, filter out _-prefixed
  mp.runPython('import json as _adder_json; _adder_keys = _adder_json.dumps([k for k in _adder_ns if not k.startswith("_")])');
  const keysJson = mp.globals.get('_adder_keys');
  const keys = keysJson ? JSON.parse(keysJson) : [];

  const result = {};
  for (const k of keys) {
    mp.runPython(`_adder_extract = _adder_ns["${k}"]`);
    result[k] = mp.globals.get('_adder_extract');
  }

  // cleanup
  try { mp.globals.delete('_adder_ns'); } catch {}
  try { mp.globals.delete('_adder_code'); } catch {}
  try { mp.globals.delete('_adder_keys'); } catch {}
  try { mp.globals.delete('_adder_extract'); } catch {}

  flushStdout(); // drain any print output from mpy execution

  return result;
}
