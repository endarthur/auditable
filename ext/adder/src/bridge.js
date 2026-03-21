// Python source strings bootstrapped at interpreter init time
//
// AdderFinder is replaced by MicroPython's native registerJsModule().
// Extensions are registered at interpreter init time via
// mp.registerJsModule(name, exports) for each entry in
// window._auditableExtensions. No sys.meta_path hack needed.

export const BRIDGE_PY = `
def _exec_cell(code, ns):
    """Execute cell in namespace. Returns last expression value or None."""
    lines = code.rstrip().splitlines()
    i = len(lines) - 1
    while i >= 0 and (not lines[i].strip() or lines[i].strip().startswith('#')):
        i -= 1
    if i >= 0 and len(lines[i]) > 0 and lines[i][0] not in (' ', chr(9)):
        last = lines[i]
        try:
            compile(last, '<expr>', 'eval')
            body = chr(10).join(lines[:i])
            if body.strip():
                exec(compile(body, '<cell>', 'exec'), ns)
            return eval(compile(last, '<cell>', 'eval'), ns)
        except SyntaxError:
            pass
    exec(compile(code, '<cell>', 'exec'), ns)
    return None

async def call(name, args=None, **kwargs):
    """Call a JS/WASM function via async bridge.
    Avoids nested-WASM crash (MicroPython is itself WASM).
    The call runs in a separate macrotask after Asyncify suspends.

    Usage:
        result = await call("_gslib.kb2d", {"data": pts, "grid": {...}})
        est = result["est"]
    """
    import js, json
    payload = args if args is not None else kwargs
    result_json = await js.globalThis._adder_call(name, json.dumps(payload))
    return json.loads(result_json)

def _build_async_wrapper(code, defines):
    """Wrap cell code in async def with global declarations for defines.
    The wrapper function is exec'd with ns as globals, so 'global' pushes
    assignments back to ns — no __main__ pollution."""
    lines = code.rstrip().splitlines()
    # detect last expression
    last_expr = None
    i = len(lines) - 1
    while i >= 0 and (not lines[i].strip() or lines[i].strip().startswith('#')):
        i -= 1
    if i >= 0 and len(lines[i]) > 0 and lines[i][0] not in (' ', chr(9)):
        last = lines[i]
        try:
            compile(last, '<expr>', 'eval')
            last_expr = last
            lines = lines[:i]
        except SyntaxError:
            pass
    # build async def
    parts = ['async def _adder_cell():']
    if defines:
        parts.append('    global ' + ', '.join(defines))
    for line in lines:
        parts.append(('    ' + line) if line.strip() else '')
    if last_expr:
        parts.append('    global _adder_last_expr')
        parts.append('    _adder_last_expr = ' + last_expr)
    return chr(10).join(parts)
`;
