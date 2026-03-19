#!/usr/bin/env node
// @gcu/webmcp bridge — MCP stdio server + WebSocket/HTTP relay for Auditable notebooks.
// Zero dependencies. Speaks MCP JSON-RPC on stdin/stdout, WebSocket + HTTP on localhost.

const http = require('http');
const crypto = require('crypto');

// ── Configuration ──

const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const TOOL_CALL_TIMEOUT = 120000;
const STALE_TIMEOUT = 10000;
const HTTP_POLL_TIMEOUT = 25000;
const HTTP_STALE_TIMEOUT = 60000;

// ── Session token ──

const sessionToken = crypto.randomBytes(12).toString('hex');

// ── State ──

const notebooks = new Map();          // id → { send, title, path, tools, state, transport, ... }
const canonicalTools = new Map();      // toolName → { notebookId, schema, providers: Set }
const pendingCalls = new Map();        // callId → { resolve, reject, timer }
let notebookCounter = 0;
let mcpInitialized = false;

function resolveNotebookId(name, path) {
  // Use provided name, or fall back to nb-N
  const base = name || `nb-${++notebookCounter}`;
  if (!notebooks.has(base)) return base;
  // If same path, it's a reconnect — reuse
  const existing = notebooks.get(base);
  if (existing && existing.path === path) return base;
  // Name collision with different notebook — append number
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!notebooks.has(candidate)) return candidate;
    const ex = notebooks.get(candidate);
    if (ex && ex.path === path) return candidate;
  }
}

// ── Minimal WebSocket server (RFC 6455, text frames only, localhost) ──

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5AB5DC85B11';

function computeAcceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

function encodeFrame(opcode, payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;  // FIN + opcode
    header[1] = len;            // no mask (server→client)
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function sendWs(ws, obj) {
  try { ws.write(encodeFrame(1, JSON.stringify(obj))); } catch (e) { /* dead socket */ }
}

function sendPing(ws) {
  try { ws.write(encodeFrame(9, '')); } catch (e) { /* dead socket */ }
}

function sendClose(ws, code, reason) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(code || 1000, 0);
  const payload = Buffer.concat([buf, Buffer.from(reason || '', 'utf8')]);
  const header = Buffer.alloc(2);
  header[0] = 0x88; // FIN + close
  header[1] = payload.length;
  try { ws.write(Buffer.concat([header, payload])); } catch (e) { /* ignore */ }
}

// ── Send to notebook (transport-agnostic) ──

function sendToNotebook(nb, msg) {
  nb.send(msg);
}

// ── Notebook message handler (shared by WS and HTTP) ──

function handleNotebookMessage(notebookId, msg) {
  const nb = notebooks.get(notebookId);
  if (!nb) return;

  if (msg.type === 'tools_changed') {
    clearTimeout(nb.staleTimer);
    nb.state = 'ready';
    nb.tools = msg.tools || [];
    remergeTools();
    if (nb.transport === 'ws') startHeartbeat(nb);

  } else if (msg.type === 'tool_result') {
    const pending = pendingCalls.get(msg.callId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCalls.delete(msg.callId);
      if (msg.error) pending.reject(msg.error);
      else pending.resolve(msg.result);
    }

  } else if (msg.type === 'user_interaction_request') {
    // Holds — user interaction happens in browser

  } else if (msg.type === 'user_interaction_result') {
    // Handled within notebook's execute flow

  } else if (msg.type === 'notification') {
    if (mcpInitialized && msg.method) {
      sendMcp({
        jsonrpc: '2.0',
        method: 'notifications/' + msg.method,
        params: { notebook: notebookId, ...(msg.params || {}) },
      });
    }

  } else if (msg.type === 'docs_available') {
    // Phase 2 — documentation tools
  }
}

// ── WS heartbeat ──

function startHeartbeat(nb) {
  nb.heartbeatTimer = setInterval(() => {
    sendPing(nb.ws);
    nb.pongTimer = setTimeout(() => {
      stderr(`Notebook ${nb.id} heartbeat timeout`);
      cleanupNotebook(nb.id);
    }, HEARTBEAT_TIMEOUT);
  }, HEARTBEAT_INTERVAL);
}

function cleanupNotebook(notebookId) {
  const nb = notebooks.get(notebookId);
  if (!nb) return;
  clearTimeout(nb.staleTimer);
  clearInterval(nb.heartbeatTimer);
  clearTimeout(nb.pongTimer);
  if (nb.ws) nb.ws.destroy();
  // Flush any waiting poll
  if (nb.pollRes) {
    try { jsonResponse(nb.pollRes, 200, []); } catch (e) { /* ignore */ }
    clearTimeout(nb.pollTimer);
  }
  notebooks.delete(notebookId);
  remergeTools();
  stderr(`Notebook ${notebookId} disconnected`);
}

// ── WebSocket connection handler ──

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = computeAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  setupWebSocket(socket);
}

function setupWebSocket(ws) {
  let notebookId = null;
  let buffer = Buffer.alloc(0);

  ws.on('error', () => { if (notebookId) cleanupNotebook(notebookId); else ws.destroy(); });
  ws.on('close', () => { if (notebookId) cleanupNotebook(notebookId); });

  ws.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const opcode = firstByte & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let payloadLen = buffer[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (buffer.length < totalLen) return;

      let payload = buffer.slice(offset + maskLen, totalLen);
      if (masked) {
        const mask = buffer.slice(offset, offset + maskLen);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buffer = buffer.slice(totalLen);

      if (opcode === 1) {
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.type === 'hello') {
          // Validate protocol
          if (msg.protocol !== PROTOCOL_VERSION) {
            sendWs(ws, { type: 'error', message: `Unsupported protocol version ${msg.protocol}. Bridge supports protocol ${PROTOCOL_VERSION}.` });
            ws.destroy();
            return;
          }
          if (msg.token !== sessionToken) {
            sendWs(ws, { type: 'error', message: 'Invalid or missing session token' });
            ws.destroy();
            return;
          }
          notebookId = resolveNotebookId(msg.name, msg.path || '');
          // Evict if reconnecting to same ID
          if (notebooks.has(notebookId)) cleanupNotebook(notebookId);
          const nb = {
            id: notebookId,
            transport: 'ws',
            ws: ws,
            send: (obj) => sendWs(ws, obj),
            title: msg.title || 'Untitled',
            path: msg.path || '',
            tools: [],
            state: 'authenticated',
            staleTimer: null,
            heartbeatTimer: null,
            pongTimer: null
          };
          notebooks.set(notebookId, nb);
          sendWs(ws, { type: 'welcome', protocol: PROTOCOL_VERSION, id: notebookId });
          stderr(`Notebook ${notebookId} connected (ws): ${nb.title}`);
          nb.staleTimer = setTimeout(() => {
            if (nb.state === 'authenticated') {
              stderr(`Notebook ${notebookId} stale (no tools_changed)`);
              sendWs(ws, { type: 'error', message: 'No tools_changed received within timeout' });
              cleanupNotebook(notebookId);
            }
          }, STALE_TIMEOUT);
        } else if (notebookId) {
          handleNotebookMessage(notebookId, msg);
          // Handle pong inline for WS
        }
      } else if (opcode === 8) {
        if (notebookId) cleanupNotebook(notebookId); else ws.destroy();
        return;
      } else if (opcode === 10) {
        // Pong
        const nb = notebooks.get(notebookId);
        if (nb) clearTimeout(nb.pongTimer);
      } else if (opcode === 9) {
        ws.write(encodeFrame(10, payload.toString('utf8')));
      }
    }
  });
}

// ── HTTP polling transport ──

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function jsonResponse(res, status, body) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function flushHttpQueue(nb) {
  if (!nb.pollRes || nb.queue.length === 0) return;
  try { jsonResponse(nb.pollRes, 200, nb.queue.splice(0)); } catch (e) { /* dead response */ }
  clearTimeout(nb.pollTimer);
  nb.pollRes = null;
  nb.pollTimer = null;
}

function handleHttpRequest(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  // POST /connect — handshake
  if (req.method === 'POST' && url.pathname === '/connect') {
    readBody(req).then(body => {
      if (body.protocol !== PROTOCOL_VERSION) {
        return jsonResponse(res, 400, { type: 'error', message: `Unsupported protocol version ${body.protocol}. Bridge supports protocol ${PROTOCOL_VERSION}.` });
      }
      if (body.token !== sessionToken) {
        return jsonResponse(res, 403, { type: 'error', message: 'Invalid or missing session token' });
      }
      const incomingPath = body.path || '';
      const notebookId = resolveNotebookId(body.name, incomingPath);
      // Evict if reconnecting to same ID
      if (notebooks.has(notebookId)) cleanupNotebook(notebookId);
      const nb = {
        id: notebookId,
        transport: 'http',
        ws: null,
        queue: [],
        pollRes: null,
        pollTimer: null,
        send: function(obj) {
          this.queue.push(obj);
          flushHttpQueue(this);
        },
        title: body.title || 'Untitled',
        path: incomingPath,
        tools: [],
        state: 'authenticated',
        staleTimer: null,
        lastPoll: Date.now()
      };
      notebooks.set(notebookId, nb);
      stderr(`Notebook ${notebookId} connected (http): ${nb.title}`);

      nb.staleTimer = setTimeout(() => {
        if (nb.state === 'authenticated') {
          stderr(`Notebook ${notebookId} stale (no tools_changed)`);
          cleanupNotebook(notebookId);
        }
      }, STALE_TIMEOUT);

      jsonResponse(res, 200, { type: 'welcome', protocol: PROTOCOL_VERSION, id: notebookId });
    }).catch(() => {
      jsonResponse(res, 400, { type: 'error', message: 'Invalid JSON body' });
    });
    return;
  }

  // POST /send — notebook sends a message
  if (req.method === 'POST' && url.pathname === '/send') {
    readBody(req).then(body => {
      if (body.token !== sessionToken) {
        return jsonResponse(res, 403, { type: 'error', message: 'Invalid token' });
      }
      const nb = notebooks.get(body.id);
      if (!nb || nb.transport !== 'http') {
        return jsonResponse(res, 404, { type: 'error', message: 'Notebook not found' });
      }
      handleNotebookMessage(body.id, body.message);
      jsonResponse(res, 200, { ok: true });
    }).catch(() => {
      jsonResponse(res, 400, { type: 'error', message: 'Invalid JSON body' });
    });
    return;
  }

  // GET /poll — long-poll for messages
  if (req.method === 'GET' && url.pathname === '/poll') {
    const token = url.searchParams.get('token');
    const id = url.searchParams.get('id');
    if (token !== sessionToken) {
      return jsonResponse(res, 403, { type: 'error', message: 'Invalid token' });
    }
    const nb = notebooks.get(id);
    if (!nb || nb.transport !== 'http') {
      return jsonResponse(res, 404, { type: 'error', message: 'Notebook not found' });
    }
    nb.lastPoll = Date.now();

    // If there are queued messages, return immediately
    if (nb.queue.length > 0) {
      return jsonResponse(res, 200, nb.queue.splice(0));
    }

    // Otherwise hold the connection (long-poll)
    // Cancel any previous poll
    if (nb.pollRes) {
      try { jsonResponse(nb.pollRes, 200, []); } catch (e) { /* ignore */ }
      clearTimeout(nb.pollTimer);
    }

    nb.pollRes = res;
    nb.pollTimer = setTimeout(() => {
      if (nb.pollRes === res) {
        jsonResponse(res, 200, []);
        nb.pollRes = null;
        nb.pollTimer = null;
      }
    }, HTTP_POLL_TIMEOUT);

    // If client disconnects before we respond
    req.on('close', () => {
      if (nb.pollRes === res) {
        nb.pollRes = null;
        clearTimeout(nb.pollTimer);
        nb.pollTimer = null;
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
}

// ── Tool merging ──

function remergeTools() {
  const oldNames = new Set(canonicalTools.keys());
  canonicalTools.clear();

  for (const [nbId, nb] of notebooks) {
    if (nb.state !== 'ready') continue;
    for (const tool of nb.tools) {
      if (canonicalTools.has(tool.name)) {
        canonicalTools.get(tool.name).providers.add(nbId);
      } else {
        canonicalTools.set(tool.name, {
          notebookId: nbId,
          schema: tool,
          providers: new Set([nbId])
        });
      }
    }
  }

  const newNames = new Set(canonicalTools.keys());
  const changed = oldNames.size !== newNames.size ||
    [...oldNames].some(n => !newNames.has(n)) ||
    [...newNames].some(n => !oldNames.has(n));

  if (changed && mcpInitialized) {
    sendMcp({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }
}

function getMcpTools() {
  const tools = [
    {
      name: 'listNotebooks',
      description: 'Use as your first call to discover connected notebooks. Returns notebook IDs, titles, file paths, and which tools each notebook offers. Notebook IDs are required for all other tool calls.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true, title: 'List connected notebooks' }
    },
    {
      name: 'getConnectionInfo',
      description: 'Returns the port:token connection string for this bridge. Give this to the user so they can paste it into a notebook\'s MCP panel (or append #mcp=port:token to the URL) to connect.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true, title: 'Get bridge connection string' }
    }
  ];
  for (const [name, info] of canonicalTools) {
    const schema = { ...info.schema };
    // Inject notebook parameter
    const props = { notebook: { type: 'string', description: 'Notebook ID (use listNotebooks to see available notebooks)' } };
    if (schema.inputSchema && schema.inputSchema.properties) {
      Object.assign(props, schema.inputSchema.properties);
    }
    const required = ['notebook'];
    if (schema.inputSchema && schema.inputSchema.required) {
      required.push(...schema.inputSchema.required);
    }
    tools.push({
      name: schema.name,
      description: schema.description,
      inputSchema: { type: 'object', properties: props, required },
      annotations: schema.annotations || {}
    });
  }
  return tools;
}

// ── Tool call routing ──

function routeToolCall(name, input) {
  return new Promise((resolve, reject) => {
    if (name === 'listNotebooks') {
      const result = [];
      for (const [id, nb] of notebooks) {
        if (nb.state !== 'ready') continue;
        result.push({ id, title: nb.title, transport: nb.transport });
      }
      return resolve(result);
    }

    if (name === 'getConnectionInfo') {
      const port = server.address().port;
      return resolve({ connectionString: `${port}:${sessionToken}`, port, instructions: 'Paste into the notebook MCP panel, or append #mcp=<connectionString> to the notebook URL.' });
    }

    const notebookId = input.notebook;
    if (!notebookId) return reject('Missing required parameter: notebook. Use listNotebooks to see available notebooks.');

    const nb = notebooks.get(notebookId);
    if (!nb) return reject(`Notebook '${notebookId}' is not connected. Use listNotebooks to see available notebooks.`);
    if (nb.state !== 'ready') return reject(`Notebook '${notebookId}' is still initializing. Try again in a moment.`);
    if (!nb.tools.some(t => t.name === name)) return reject(`Notebook '${notebookId}' does not have tool '${name}'. Use listNotebooks to check which tools each notebook offers.`);

    // Strip notebook param, forward to page
    const { notebook, ...rest } = input;
    const callId = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      reject(`Tool call timed out after ${TOOL_CALL_TIMEOUT / 1000}s. The notebook may be unresponsive.`);
    }, TOOL_CALL_TIMEOUT);

    pendingCalls.set(callId, { resolve, reject, timer });
    sendToNotebook(nb, { type: 'tool_invoke', callId, name, input: rest });
  });
}

// ── MCP stdio transport (newline-delimited JSON-RPC) ──

let stdinBuffer = '';

function sendMcp(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handleMcpMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    mcpInitialized = true;
    sendMcp({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'auditable-mcp-bridge', version: '1.0.0' },
        instructions: 'Auditable computational notebook bridge. Use listNotebooks to see connected notebooks. Use listCells to see cells in a notebook. Interact with cells via getCellOutput, getCellSource, updateCellSource. Use pauseAutorun/resumeAutorun to batch edits. Use getNotebookStatus to check for errors after edits. Call getDocumentation for API reference on Auditable\'s builtins, extensions, and conventions.'
      }
    });

  } else if (method === 'notifications/initialized') {
    // Client acknowledged init — no response needed

  } else if (method === 'tools/list') {
    sendMcp({ jsonrpc: '2.0', id, result: { tools: getMcpTools() } });

  } else if (method === 'tools/call') {
    const { name, arguments: args } = params;
    routeToolCall(name, args || {}).then(
      result => sendMcp({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } }),
      error => sendMcp({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof error === 'string' ? error : JSON.stringify(error) }], isError: true } })
    );

  } else if (method === 'ping') {
    sendMcp({ jsonrpc: '2.0', id, result: {} });

  } else if (id) {
    // Unknown method with id — return error
    sendMcp({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let newlineIdx;
  while ((newlineIdx = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, newlineIdx).trim();
    stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
    if (line) {
      try { handleMcpMessage(JSON.parse(line)); }
      catch (e) { stderr(`Failed to parse MCP message: ${e.message}`); }
    }
  }
});

// ── Setup ──

function setup() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(process.cwd(), '.claude');
  const hooksDir = path.join(dir, 'hooks');
  const settingsPath = path.join(dir, 'settings.json');
  const hookPath = path.join(hooksDir, 'protect-notebooks.js');

  // Ensure directories
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir);

  // Write hook script
  const hookScript = `#!/usr/bin/env node
// Blocks Claude from reading/editing auditable notebook HTML files directly.
// Steers toward MCP bridge tools instead.
const fs = require('fs');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  try {
    const msg = JSON.parse(input);
    const filePath = msg.tool_input?.file_path || msg.tool_input?.command || '';
    // Only check Read/Edit/Write on .html files
    if (!filePath.endsWith('.html')) process.exit(0);
    // Read first 200 bytes to check for magic marker
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(200);
    fs.readSync(fd, buf, 0, 200, 0);
    fs.closeSync(fd);
    if (buf.toString('utf8').includes('<!--AUDITABLE-NOTEBOOK-->')) {
      process.stderr.write('BLOCKED: This is an auditable notebook. Use the auditable MCP tools (listNotebooks, listCells, getCellSource, etc.) instead of reading the file directly.\\n');
      process.exit(2);
    }
  } catch (e) {
    // If we can't read the file or parse input, allow the operation
  }
  process.exit(0);
});
`;
  fs.writeFileSync(hookPath, hookScript);

  // Merge into settings.json
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) {}
  }
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  // Check if our hook is already registered
  const hookCmd = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/protect-notebooks.js"`;
  const already = settings.hooks.PreToolUse.some(entry =>
    entry.hooks && entry.hooks.some(h => h.command === hookCmd)
  );

  if (!already) {
    settings.hooks.PreToolUse.push({
      matcher: 'Read|Edit|Write',
      hooks: [{
        type: 'command',
        command: hookCmd
      }]
    });
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('Setup complete:');
  console.log('  ' + hookPath);
  console.log('  ' + settingsPath);
  if (already) console.log('  (hook was already registered)');
}

if (process.argv.includes('--setup')) {
  setup();
  process.exit(0);
}

// ── Startup ──

function stderr(msg) {
  process.stderr.write(`[webmcp] ${msg}\n`);
}

const server = http.createServer(handleHttpRequest);

server.on('upgrade', handleUpgrade);

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const connStr = `${port}:${sessionToken}`;
  stderr(`@gcu/webmcp bridge listening on port ${port}`);
  stderr(`Connect with: __auditable_mcp.connect("${connStr}")`);
  stderr(`Or add #mcp=${connStr} to your notebook URL`);
});

// Sweep stale HTTP notebooks (no poll in HTTP_STALE_TIMEOUT)
setInterval(() => {
  const now = Date.now();
  for (const [id, nb] of notebooks) {
    if (nb.transport === 'http' && now - nb.lastPoll > HTTP_STALE_TIMEOUT) {
      stderr(`Notebook ${id} stale (no poll for ${Math.round((now - nb.lastPoll) / 1000)}s)`);
      cleanupNotebook(id);
    }
  }
}, 15000);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
