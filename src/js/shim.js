// shim.js — WebMCP polyfill + WebSocket/HTTP bridge client
// Generic: knows nothing about Auditable. Could be used by any web page.
// Tries WebSocket first; falls back to HTTP polling (works from file:// origins).

const _mcpTools = new Map();
let _mcpTransport = null;          // { type: 'ws'|'http', ... }
let _mcpState = 'disconnected';    // disconnected | connecting | connected | error
let _mcpNotebookId = null;
let _mcpPortAndToken = null;
let _mcpReconnectTimer = null;
let _mcpName = null;
let _mcpOnStateChange = null;

function _mcpSetState(s) {
  _mcpState = s;
  if (_mcpOnStateChange) _mcpOnStateChange(s, _mcpNotebookId);
  const el = document.getElementById('statusMcp');
  if (el) {
    if (s === 'disconnected') { el.textContent = ''; el.className = 'status-mcp'; }
    else if (s === 'connecting') { el.textContent = 'MCP\u2026'; el.className = 'status-mcp mcp-connecting'; }
    else if (s === 'connected') { el.textContent = 'MCP ' + (_mcpNotebookId || ''); el.className = 'status-mcp mcp-connected'; }
    else if (s === 'error') { el.textContent = 'MCP err'; el.className = 'status-mcp mcp-error'; }
  }
}

function _mcpSerializeTools() {
  const tools = [];
  for (const [name, tool] of _mcpTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || undefined,
      annotations: tool.annotations || undefined
    });
  }
  return tools;
}

function _mcpDerivedName() {
  // Strip common prefixes from title
  var title = document.title || 'Untitled';
  title = title.replace(/^Auditable\s*[\u2014\u2013\-]+\s*/i, '');
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'notebook';
}

function _mcpEffectiveName() {
  return _mcpName || _mcpDerivedName();
}

// ── Transport-agnostic send ──

function _mcpSend(obj) {
  if (!_mcpTransport) return;
  if (_mcpTransport.type === 'ws') {
    if (_mcpTransport.ws && _mcpTransport.ws.readyState === WebSocket.OPEN) {
      _mcpTransport.ws.send(JSON.stringify(obj));
    }
  } else if (_mcpTransport.type === 'http') {
    _mcpHttpSend(obj);
  }
}

// ── WebSocket transport ──

function _mcpConnectWs(port, token) {
  return new Promise(function(resolve, reject) {
    var ws;
    try { ws = new WebSocket('ws://localhost:' + port); } catch (e) { return reject(e); }
    var timer = setTimeout(function() { ws.close(); reject(new Error('timeout')); }, 3000);

    ws.onopen = function() {
      clearTimeout(timer);
      _mcpTransport = { type: 'ws', ws: ws };
      _mcpSend({
        type: 'hello',
        protocol: 1,
        title: document.title || 'Untitled',
        name: _mcpEffectiveName(),
        path: window.location.href,
        token: token
      });
      _mcpSend({ type: 'tools_changed', tools: _mcpSerializeTools() });
      resolve();
    };

    ws.onmessage = function(event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      _mcpHandleMessage(msg);
    };

    ws.onclose = function() {
      // Only act if this WS is still the active transport (HTTP fallback may have taken over)
      if (!_mcpTransport || _mcpTransport.type !== 'ws' || _mcpTransport.ws !== ws) return;
      _mcpNotebookId = null;
      _mcpTransport = null;
      _mcpSetState('disconnected');
      if (_mcpPortAndToken) {
        _mcpReconnectTimer = setTimeout(function() { _mcpConnect(_mcpPortAndToken); }, 2000);
      }
    };

    ws.onerror = function() {
      clearTimeout(timer);
      reject(new Error('ws failed'));
    };
  });
}

// ── HTTP polling transport ──

function _mcpHttpSend(obj) {
  if (!_mcpTransport || _mcpTransport.type !== 'http') return;
  var t = _mcpTransport;
  fetch('http://localhost:' + t.port + '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: t.token, id: t.id, message: obj })
  }).catch(function() { /* ignore send errors — poll will detect disconnect */ });
}

function _mcpConnectHttp(port, token) {
  _mcpSetState('connecting');
  return fetch('http://localhost:' + port + '/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: 1,
      token: token,
      title: document.title || 'Untitled',
      name: _mcpEffectiveName(),
      path: window.location.href
    })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.type === 'error') throw new Error(data.message);
    _mcpTransport = { type: 'http', port: port, token: token, id: data.id, polling: true };
    _mcpNotebookId = data.id;
    _mcpSetState('connected');
    // Send tools
    _mcpHttpSend({ type: 'tools_changed', tools: _mcpSerializeTools() });
    // Start poll loop
    _mcpPollLoop();
  });
}

function _mcpPollLoop() {
  if (!_mcpTransport || _mcpTransport.type !== 'http' || !_mcpTransport.polling) return;
  var t = _mcpTransport;
  fetch('http://localhost:' + t.port + '/poll?token=' + encodeURIComponent(t.token) + '&id=' + encodeURIComponent(t.id))
    .then(function(r) { return r.json(); })
    .then(function(messages) {
      if (!Array.isArray(messages)) return;
      for (var i = 0; i < messages.length; i++) {
        _mcpHandleMessage(messages[i]);
      }
      // Continue polling
      _mcpPollLoop();
    })
    .catch(function() {
      // Connection lost
      _mcpTransport = null;
      _mcpNotebookId = null;
      _mcpSetState('disconnected');
      if (_mcpPortAndToken) {
        _mcpReconnectTimer = setTimeout(function() { _mcpConnect(_mcpPortAndToken); }, 2000);
      }
    });
}

// ── Shared message handler ──

function _mcpHandleMessage(msg) {
  if (msg.type === 'welcome') {
    _mcpNotebookId = msg.id;
    _mcpSetState('connected');

  } else if (msg.type === 'tool_invoke') {
    _mcpHandleInvoke(msg);

  } else if (msg.type === 'ping') {
    _mcpSend({ type: 'pong' });

  } else if (msg.type === 'error') {
    console.error('[webmcp]', msg.message);
    _mcpSetState('error');
  }
}

// ── Connect (try WS, fall back to HTTP) ──

function _mcpConnect(portAndToken) {
  if (typeof portAndToken !== 'string' || !portAndToken.includes(':')) {
    throw new Error('Token required: use "port:token" format');
  }
  var forceHttp = portAndToken.endsWith(':http');
  var connStr = forceHttp || portAndToken.endsWith(':ws') ? portAndToken.slice(0, portAndToken.lastIndexOf(':')) : portAndToken;
  _mcpPortAndToken = portAndToken;
  var idx = connStr.indexOf(':');
  var port = connStr.substring(0, idx);
  var token = connStr.substring(idx + 1);

  if (_mcpTransport) {
    if (_mcpTransport.type === 'ws' && _mcpTransport.ws) {
      try { _mcpTransport.ws.close(); } catch (e) { /* ignore */ }
    }
    if (_mcpTransport.type === 'http') _mcpTransport.polling = false;
    _mcpTransport = null;
  }
  clearTimeout(_mcpReconnectTimer);

  _mcpSetState('connecting');
  var useHttp = forceHttp || window.location.protocol === 'file:';
  (useHttp ? _mcpConnectHttp(port, token) : _mcpConnectWs(port, token).catch(function() {
    // WS failed — fall back to HTTP
    return _mcpConnectHttp(port, token);
  })).catch(function(e) {
    console.error('[webmcp] connection failed:', e.message || e);
    _mcpSetState('error');
    // Retry after delay
    if (_mcpPortAndToken) {
      _mcpReconnectTimer = setTimeout(function() { _mcpConnect(_mcpPortAndToken); }, 5000);
    }
  });
}

function _mcpDisconnect() {
  _mcpPortAndToken = null;
  clearTimeout(_mcpReconnectTimer);
  if (_mcpTransport) {
    if (_mcpTransport.type === 'ws' && _mcpTransport.ws) {
      try { _mcpTransport.ws.close(); } catch (e) { /* ignore */ }
    }
    if (_mcpTransport.type === 'http') _mcpTransport.polling = false;
    _mcpTransport = null;
  }
  _mcpNotebookId = null;
  _mcpSetState('disconnected');
}

async function _mcpHandleInvoke(msg) {
  const tool = _mcpTools.get(msg.name);
  if (!tool) {
    _mcpSend({ type: 'tool_result', callId: msg.callId, error: 'Tool not found: ' + msg.name });
    return;
  }
  try {
    const client = {
      requestUserInteraction: function(callback) {
        return callback();
      }
    };
    const result = await tool.execute(msg.input || {}, client);
    _mcpSend({ type: 'tool_result', callId: msg.callId, result: result });
  } catch (e) {
    _mcpSend({ type: 'tool_result', callId: msg.callId, error: e.message || String(e) });
  }
}

// Polyfill navigator.modelContext
if (!navigator.modelContext) {
  navigator.modelContext = {
    registerTool: function(tool) {
      if (!tool || !tool.name) throw new Error('Tool must have a name');
      _mcpTools.set(tool.name, tool);
      if (_mcpState === 'connected') {
        _mcpSend({ type: 'tools_changed', tools: _mcpSerializeTools() });
      }
    },
    unregisterTool: function(name) {
      _mcpTools.delete(name);
      if (_mcpState === 'connected') {
        _mcpSend({ type: 'tools_changed', tools: _mcpSerializeTools() });
      }
    }
  };
}

// Public API
window.__auditable_mcp = {
  connect: _mcpConnect,
  disconnect: _mcpDisconnect,
  notify: function(method, params) { _mcpSend({ type: 'notification', method, params }); },
  get state() { return _mcpState; },
  get notebookId() { return _mcpNotebookId; },
  get name() { return _mcpEffectiveName(); },
  set name(v) { _mcpName = v || null; },
  get derivedName() { return _mcpDerivedName(); },
  set onStateChange(fn) { _mcpOnStateChange = fn; }
};

// Auto-connect from URL fragment: #mcp=port:token
(function() {
  const hash = window.location.hash;
  if (hash) {
    const m = hash.match(/[#&]mcp=([^&]+)/);
    if (m) {
      setTimeout(function() { _mcpConnect(decodeURIComponent(m[1])); }, 500);
    }
  }
})();
