// src/recorder/engineConsole.js
//
// Pure classifier for **Viz Engine command-console** lines (TCP 6100), the ONLY
// place a profile *cleanup* is observable at this site. Synchronous and side-
// effect free, so it is testable offline against committed console fixtures. The
// stateful "is this a cleanup block?" debounce lives in EngineConsoleAdapter;
// this module is the pure per-line classifier.
//
// WHY the engine console, not the MSE.  A profile cleanup is a PROFILE command
// (`POST /profiles/<p>/cleanup`, official MSE doc: "Profile Commands … cleanup,
// initialize, take, continue, out"). It is executed by the MSE firing at the
// ENGINE — three empty `RENDERER*<LAYER> SET_OBJECT` (unload each layer) + the
// `SCENE/GEOM/IMAGE/FONT/MATERIAL/MAPS CACHE CLEANUP` block — NOT by mutating the
// element-level VDOM the recorder subscribes to on the actor (8595). So a profile
// cleanup changes NO observable MSE state: `/state/last_taken_element` stays
// frozen on the last take (it is the take cursor — official doc: "the element
// handler is responsible for recording … the last taken element"; nothing
// documents cleanup clearing it), the per-line A/O events never fire, and
// `offair.js`'s `/Cleaning up viz-handlers/` system-log line is not emitted. The
// engine console is the read-only signal. (On-site evidence 2026-06-25; the local
// dev MSE 5.3.5 confirmed `/state/last_taken_element` is `inexistent` when nothing
// is taken and exposes no cleanup-observable `/state` node.)
//
// ENGINE SEMANTICS (engine command reference / MSE doc §viz handler):
//   * `RENDERER*<LAYER> SET_OBJECT SCENE*<name>`  loads a scene  => a TAKE/load.
//   * `RENDERER*<LAYER> SET_OBJECT`  (NO object)  unloads the layer => a CLEAR.
//   * `<SCENE|GEOM|IMAGE|FONT|MATERIAL|MAPS CACHE> CLEANUP … DONE`  the teardown
//     block a profile cleanup runs (a normal per-element take-out does NOT run it).
//
// FALSE-POSITIVE guards (grounded in the real dev-engine console, Viz 3.14.5):
//   * Lines beginning `failed to process command …` are command FAILURES (e.g. the
//     GET-on-SET-only probes that flood the console) — never a real clear.
//   * `RENDERER*<LAYER>*TREE*#<id>*GEOM*TYPE` etc. contain `GEOM`/`MATERIAL` but
//     are per-object property reads, NOT `… CLEANUP` — the `\bCLEANUP\b` anchor
//     excludes them.
//   * A `SET_OBJECT` WITH a scene argument is a load (take), classified `load`,
//     never `clear`.

// A renderer layer token: FRONT_LAYER / MAIN_LAYER / BACK_LAYER (and any *_LAYER).
const LAYER_RE = /RENDERER\*([A-Z][A-Z0-9_]*?_LAYER)\b/i;
// The cleanup-block verbs the engine logs during a profile cleanup teardown.
const CLEANUP_RE = /\b(SCENE|GEOM|IMAGE|FONT|MATERIAL|MAPS\s+CACHE)\s+CLEANUP\b/i;

// Classify one engine-console line. Returns one of:
//   { kind:'clear',   layer }            an empty RENDERER*<LAYER> SET_OBJECT (unload)
//   { kind:'load',    layer, object }    RENDERER*<LAYER> SET_OBJECT <obj> (a take/load)
//   { kind:'cleanup', what }             a <X> CLEANUP teardown line
// or null when the line carries no clear/load/cleanup signal.
function parseEngineConsoleLine(line) {
  if (!line) return null;
  const text = String(line).trim();
  if (!text) return null;

  // Command FAILURES are never a real action (guards against the GET-on-SET-only
  // probe flood that dominates an idle console).
  if (/^failed to process command\b/i.test(text)) return null;

  // SET_OBJECT on a renderer layer: empty => clear (unload), with an arg => load.
  const so = text.match(/RENDERER\*([A-Z][A-Z0-9_]*?_LAYER)\s+SET_OBJECT\b(.*)$/i);
  if (so) {
    const layer = so[1].toUpperCase();
    const rest = (so[2] || '').trim();
    if (rest === '') return { kind: 'clear', layer };
    return { kind: 'load', layer, object: rest };
  }

  // The cleanup teardown block (a profile cleanup runs it; a take-out does not).
  const cu = text.match(CLEANUP_RE);
  if (cu) return { kind: 'cleanup', what: cu[1].toUpperCase().replace(/\s+/g, ' ') };

  return null;
}

module.exports = { parseEngineConsoleLine, LAYER_RE, CLEANUP_RE };
