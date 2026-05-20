// The REPL loop. Reads a command line via geas's makeLineEditor (with
// up/down history recall wired through onHistory), runs it via the
// worker-hosted shell, repeats. Output streams to the terminal through
// the client's onStdout/onStderr/onBlock sinks set up in init.js.

// geas emits plain \n; a VT terminal needs \r\n to return the carriage.
function _toCRLF(text) {
  return String(text).replace(/\r?\n/g, '\r\n');
}

function startRepl(geas, client, adapter, terminal) {
  const replEdit = geas.makeLineEditor(adapter);
  const history = GS.history;

  // Opening banner.
  terminal.write('\x1b[33mgeas\x1b[0m \x1b[2m— the GCU shell\x1b[0m\r\n');
  terminal.write('\x1b[2mtry \x1b[0mcat /home/welcome.txt\x1b[2m or \x1b[0mls /home\x1b[2m.  up-arrow recalls history.\x1b[0m\r\n\r\n');

  async function loop() {
    // The loop never returns — each iteration reads one command line
    // and runs it. Errors are caught and printed so a single bad
    // command can't kill the REPL.
    for (;;) {
      // Fresh history cursor for each prompt: starts "past the newest
      // entry" so the first up-arrow recalls the most recent command.
      let histPos = history.length;
      const onHistory = (dir) => {
        histPos = Math.max(0, Math.min(history.length, histPos + dir));
        return histPos < history.length ? history[histPos] : '';
      };

      const cwd = client.cwd || '/';
      const prompt = `\x1b[36m${cwd}\x1b[0m \x1b[33m$\x1b[0m `;

      let result;
      try {
        result = await replEdit({ prompt, onHistory });
      } catch {
        terminal.write('\r\n');
        continue;
      }
      // Ctrl+D / Ctrl+C at the prompt: makeLineEditor resolves {eof}.
      // Just draw a fresh prompt — this isn't a session-ending shell.
      if (!result || result.eof) continue;

      const line = (result.line || '').trim();
      if (line === '') continue;
      if (history[history.length - 1] !== line) history.push(line);

      try {
        await client.exec(line + '\n');
      } catch (err) {
        terminal.write('\x1b[31mgeas: ' + _toCRLF(err && err.message || err) + '\x1b[0m\r\n');
      }
    }
  }
  loop();
}
