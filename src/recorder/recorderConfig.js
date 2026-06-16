// src/recorder/recorderConfig.js
//
// Resolve recorder configuration with precedence: CLI flag > env (.env / process
// env) > config/config.js default. Nothing about the Stripe — profile, channel,
// Pilot host, template id — is hard-coded; every value is overridable here.

const fs = require('fs');
const path = require('path');

// Defaults mirror src/server/config/config.js. The recorder keeps its own copy
// rather than importing that module, which pulls in dotenv + server-only config.
const baseConfig = {
  MSE_HOST: '127.0.0.1',
  STOMP_PORT: 8582,
  MSE_WEBSOCKET_PORT: 8595,
  PILOT_PORT: 8177,
  TARGET_TEMPLATE_ID: '16082',
};

// Minimal .env loader (no dependency). Lines of KEY=VALUE; # comments ignored.
function loadDotEnv(cwd) {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

// Parse `--key value` and `--key=value`; `--no-foo` sets foo=false; bare `--foo`
// (followed by another flag or nothing) sets foo=true.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    let key = a.slice(2);
    if (key.startsWith('no-')) {
      out[key.slice(3)] = false;
      continue;
    }
    const eq = key.indexOf('=');
    if (eq !== -1) {
      out[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function resolveConfig(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const cli = parseArgs(argv);
  const dot = loadDotEnv(cwd);
  // env precedence inside the "env" tier: real process env beats .env file.
  const e = (k) => (env[k] !== undefined ? env[k] : dot[k]);

  const pick = (cliKey, envKey, dflt) => {
    if (cli[cliKey] !== undefined) return cli[cliKey];
    if (envKey && e(envKey) !== undefined) return e(envKey);
    return dflt;
  };

  const num = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? d : n;
  };

  // A host may arrive as a bare host, or (e.g. from a shared .env) as a full URL
  // like "http://8.217.127.27:8580". Strip scheme and any trailing :port so it
  // composes cleanly into ws://<host>:<port>.
  const cleanHost = (h) => {
    if (h == null) return h;
    let s = String(h).trim().replace(/^[a-z]+:\/\//i, '');
    s = s.replace(/\/.*$/, '');     // drop any path
    s = s.replace(/:\d+$/, '');     // drop any :port
    return s || null;
  };

  const cfg = {
    mseHost: cleanHost(pick('mse-host', 'MSE_HOST', baseConfig.MSE_HOST)),
    stompPort: num(pick('stomp-port', 'STOMP_PORT', baseConfig.STOMP_PORT), 8582),
    actorPort: num(pick('actor-port', 'MSE_WEBSOCKET_PORT', baseConfig.MSE_WEBSOCKET_PORT), 8595),
    restPort: num(pick('rest-port', 'MSE_REST_PORT', 8580), 8580),

    // Pilot is intentionally allowed to be empty/unset → content stays pending.
    pilotHost: cleanHost(pick('pilot-host', 'PILOT_HOST', null)),
    pilotPort: num(pick('pilot-port', 'PILOT_PORT', baseConfig.PILOT_PORT), 8177),

    profile: pick('profile', 'PROFILE_NAME', null),
    channel: pick('channel', 'CHANNEL_NAME', null),

    // The Stripe identity — overridable, never hard-coded to a value.
    stripeTemplateId: pick('stripe-template', 'TARGET_TEMPLATE_ID', baseConfig.TARGET_TEMPLATE_ID) || null,

    // Which numeric Pilot field is Line_2 (drives 1-line vs 2-line) and the
    // optional exclusive-badge field. Confirm at work; defaults are best-guess.
    line1Field: String(pick('line1-field', 'LINE1_FIELD', '0')),
    line2Field: String(pick('line2-field', 'LINE2_FIELD', '1')),
    exclusiveField: pick('exclusive-field', 'EXCLUSIVE_FIELD', null),

    outDir: pick('out', 'RECORD_DIR', 'recordings'),
    pollIntervalMs: num(pick('poll-interval', 'POLL_INTERVAL_MS', 2000), 2000),
    // Re-fetch on-air Pilot content each poll to catch changes/exclusive while on air.
    contentPoll: pick('content-poll', null, true) !== false && pick('content-poll', null, true) !== 'false',
    storeRaw: pick('store-raw', null, true) !== false && pick('store-raw', null, true) !== 'false',
    // Optional auto-stop after N seconds (handy for the local proof run / CI).
    durationSec: cli['duration'] !== undefined ? num(cli['duration'], 0) : 0,
    pilotTimeoutMs: num(pick('pilot-timeout', null, 5000), 5000),
  };

  // Normalise: treat empty strings / "none" as unset for the optional host/ids.
  if (cfg.pilotHost === '' || cfg.pilotHost === 'none') cfg.pilotHost = null;
  if (cfg.exclusiveField === '' ) cfg.exclusiveField = null;

  return cfg;
}

module.exports = { resolveConfig, parseArgs, loadDotEnv };
