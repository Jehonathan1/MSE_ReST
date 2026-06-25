// src/recorder/adapters/engineConsoleAdapter.js
//
// Engine-console CLEAR detector — the **Viz Engine command port** (TCP 6100)
// adapter. A profile *cleanup* is invisible on the MSE actor stream (see
// ../engineConsole.js for why), so this OPT-IN adapter tails the engine console
// and synthesizes a `clear` when it sees the cleanup teardown block. It is
// orthogonal to `--source` (which picks the take/off-air detector): it only adds
// the clear signal a profile cleanup needs, and is built ONLY when explicitly
// enabled (`--engine-console`), so the default recorder is byte-for-byte unchanged.
//
// CONTRACT (detection-adapter interface — see ./index.js):
//   - `source` 'engine'; `needsActor` false; `needsStomp` false; `needsEngine` true
//   - emits 'clear' { reason } — the core off-airs every on-air element
//   - attachEngine() once on start (self-owns its TCP socket); stop()
//
// Two halves:
//   1. ingestConsoleLines(text)  PURE detection — classify each line through the
//      offline-tested ./engineConsole.parseEngineConsoleLine and latch ONE 'clear'
//      per cleanup block. Unit-tested without a socket.
//   2. the transport  CONSOLE REDIRECT (once) + CONSOLE FLUSH poll + tail the file
//      — read-only w.r.t. playout (never SET/take/cue/clear). Modeled on the proven
//      viz-cmd client. NEEDS LIVE CONFIRMATION on the next on-site/home trip (the
//      offline tests prove the classifier + latch + core fan-out; the socket/file
//      glue can only be exercised against a live engine driving a real cleanup).

const { EventEmitter } = require('events');
const net = require('net');
const fs = require('fs');
const { parseEngineConsoleLine } = require('../engineConsole');

class EngineConsoleAdapter extends EventEmitter {
  constructor({ cfg = {}, now = () => new Date().toISOString(), log = () => {} } = {}) {
    super();
    this.source = 'engine';
    this.needsActor = false;
    this.needsStomp = false;
    this.needsEngine = true;

    this.cfg = cfg;
    this.now = now;
    this.log = log;

    // detection latch
    this.armed = false;            // true once a cleanup block has fired, until a load resets it
    this.clearedLayers = new Set(); // distinct layers cleared in the current window

    // transport
    this.socket = null;
    this.pollTimer = null;
    this.fileOffset = 0;           // bytes of the console file already processed
    this.carry = '';               // partial trailing line between reads
    this.consoleFile = cfg.engineConsoleFile
      || 'C:\\ProgramData\\Vizrt\\viz3\\viz-cmd-console.log';
  }

  // ---- PURE detection (offline-tested) ----
  // Feed a chunk of console text; classify each complete line and latch ONE
  // 'clear' per cleanup block. A cleanup block is identified by a CLEANUP verb
  // (definitive — a per-element take-out never runs it) OR by an all-layer unload
  // (>=2 distinct empty `RENDERER*<LAYER> SET_OBJECT`). A single empty SET_OBJECT
  // alone does NOT fire — that can be a normal one-layer take-out, which the
  // element-level detector already handles. A `load` (SET_OBJECT WITH a scene)
  // re-arms the detector for the next cleanup.
  ingestConsoleLines(text) {
    if (text == null) return;
    const buf = this.carry + String(text);
    const parts = buf.split(/\r?\n/);
    this.carry = parts.pop(); // last element is a (possibly partial) trailing line
    for (const line of parts) this._ingestLine(line);
  }

  _ingestLine(line) {
    const ev = parseEngineConsoleLine(line);
    if (!ev) return;

    if (ev.kind === 'load') {
      // a take re-populated a layer — reset the latch/window for the next cleanup.
      this.armed = false;
      this.clearedLayers.clear();
      return;
    }

    if (ev.kind === 'clear') {
      this.clearedLayers.add(ev.layer);
      // all-layer unload (>=2 layers) is the cleanup's clear signature.
      if (!this.armed && this.clearedLayers.size >= 2) this._fireClear('all-layer-unload');
      return;
    }

    if (ev.kind === 'cleanup') {
      // a SCENE/GEOM/IMAGE/FONT/MATERIAL/MAPS CACHE CLEANUP line — definitive.
      if (!this.armed) this._fireClear(`${ev.what.toLowerCase()} cleanup`);
    }
  }

  _fireClear(reason) {
    this.armed = true;
    this.log(`[engine] CLEAR detected (${reason}) on the engine console -> synthesizing a clear`);
    this.emit('clear', { reason });
  }

  // ---- transport (read-only; needs live confirmation) ----
  attachEngine() {
    const host = this.cfg.engineHost || this.cfg.mseHost || '127.0.0.1';
    const port = this.cfg.enginePort || 6100;
    const pollMs = this.cfg.engineConsolePollMs || 1000;
    this.log(`[engine] console clear-detector tailing ${host}:${port} -> ${this.consoleFile}`);

    const sock = new net.Socket();
    this.socket = sock;
    sock.setKeepAlive(true);
    sock.on('error', (e) => this.log(`[engine] console socket error: ${e && e.message}`));
    sock.on('close', () => { if (this.socket === sock) this.socket = null; });
    sock.connect(port, host, () => {
      // (1) point the engine console at our file (once). Read-only w.r.t playout.
      this._send('CONSOLE REDIRECT ' + this.consoleFile);
      // seed the offset to current EOF so we only react to NEW lines.
      try { this.fileOffset = fs.statSync(this.consoleFile).size; } catch (e) { this.fileOffset = 0; }
      // (2) poll: flush the engine's buffer, then tail new bytes.
      this.pollTimer = setInterval(() => this._poll(), pollMs);
    });
  }

  _send(cmd) {
    if (this.socket && !this.socket.destroyed) {
      try { this.socket.write('0 ' + cmd + '\0'); } catch (e) { /* best-effort */ }
    }
  }

  _poll() {
    this._send('CONSOLE FLUSH');
    // read whatever has been appended since fileOffset.
    let stat;
    try { stat = fs.statSync(this.consoleFile); } catch (e) { return; }
    if (stat.size < this.fileOffset) this.fileOffset = 0; // file rotated/truncated
    if (stat.size === this.fileOffset) return;
    let fd;
    try {
      fd = fs.openSync(this.consoleFile, 'r');
      const len = stat.size - this.fileOffset;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, this.fileOffset);
      this.fileOffset = stat.size;
      this.ingestConsoleLines(b.toString('utf8'));
    } catch (e) {
      /* best-effort read */
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
    }
  }

  stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.socket) { try { this.socket.destroy(); } catch (e) { /* ignore */ } this.socket = null; }
  }
}

module.exports = { EngineConsoleAdapter };
