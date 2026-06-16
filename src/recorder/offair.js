// src/recorder/offair.js
//
// Pure detection of take/out actions from the PepTalk **actor** event stream.
// Synchronous and side-effect free, so it is testable offline against committed
// fixture strings. The stateful parts (begin-framing, line-name cross-reference,
// active-element attribution) live in DirectorAdapter; this module is the pure
// per-message classifier.
//
// PRIMARY model — the OFFICIAL Media Sequencer PepTalk protocol (Vizrt "Media
// Sequencer document and API", §"The PepTalk Protocol", commands/events list).
// When events are enabled (protocol negotiated WITHOUT the `noevents` capability)
// the server reflects every VDOM change as a uri-form event using one of FIVE
// verbs — delete / insert / move / replace / set — serialized identically to the
// client commands, e.g.:
//
//   * set text <path>/state/current O     a `set` on the transition-logic state
//   * replace  <path> <xml…state…O…>      a `replace` to the inactive state
//   * delete   <path>                      the active state node removed
//
// An element going OFF AIR surfaces as a `set`/`replace` on its transition-logic
// state node (active 'A' -> inactive 'O') or a `delete` removing it from the
// active state path. That is the official OUT signal and is what this module
// detects first. 'A' (active) is the corresponding IN signal.
//
// Each event stream caused by *our own* command is preceded by `<id> begin`
// (official §"Client messages"); events with no preceding own-begin are EXTERNAL
// — an operator/Director taking on or off air — the read-only signal we want.
// The begin-framing is enforced by DirectorAdapter (which knows our command ids).
//
// FALLBACK model — heuristics proven in branch `director-with-out` and personal
// KB §4b, for installs/captures that surface the OUT differently:
//
//   * set text <path>/current out                         explicit out command
//   * STATE_<entry name="LINE">…<entry name="state">O…    XML state form
//   * /state/system/log "Cleaning up viz-handlers…show…profile…"  show teardown
//   + cross-reference by scheduler line name when the element id is absent.
//
// Where the official event model and a branch heuristic differ, the official
// model wins (it is the documented protocol); the heuristics remain fallbacks.

// Element id appears as .../pilotdb/elements/<id> (with or without /external).
const ELEMENT_ID_RE = /\/pilotdb\/elements\/(\d+)/;
const LINE_RE = /(LM-Line_\d+)/;

function extractElementId(text) {
  if (!text) return null;
  const m = text.match(ELEMENT_ID_RE);
  return m ? m[1] : null;
}

function extractLineName(text) {
  if (!text) return null;
  const m = text.match(LINE_RE);
  return m ? m[1] : null;
}

function lineNumberOf(lineName) {
  const m = lineName && lineName.match(/LM-Line_(\d+)/);
  return m ? m[1] : null;
}

// Normalize a detected action into the shape the adapter consumes.
//   { action:'take'|'out', verb, lineName, lineNumber, elementId, rule }
// `elementId` is whatever the message itself names; it may be null (the adapter
// then cross-references by line name, then falls back to the active element).
function mk(action, lineName, message, verb, rule, elementId) {
  return {
    action,
    verb: verb || null,
    lineName: lineName || null,
    lineNumber: lineNumberOf(lineName),
    elementId: elementId !== undefined ? elementId : extractElementId(message),
    rule,
  };
}

// Parse one actor message for a take/out action; returns the normalized object
// or null when the message carries no director state action.
function parseDirectorEvent(message) {
  if (!message) return null;

  // ===== OFFICIAL PepTalk uri-form events (primary) =========================

  // `set` verb on the transition-logic state text node: the canonical IN/OUT.
  //   * set text <path>/state/current A   => take   (active)
  //   * set text <path>/state/current O   => out    (inactive)
  let m = message.match(/\bset text .+?\/([^/\s]+)\/state\/current ([AO])\b/);
  if (m) return mk(m[2] === 'A' ? 'take' : 'out', m[1], message, 'set', 'set_state');

  // `replace` verb to a new state: inspect the replacement XML for the value.
  //   * replace <path> <…<entry name="state">A|O</entry>…>
  m = message.match(/\breplace\s+(\S+)\s+.*?<entry name="state">([AO])<\/entry>/);
  if (m) {
    const lineName = extractLineName(m[1]) || extractLineName(message);
    return mk(m[2] === 'A' ? 'take' : 'out', lineName, message, 'replace', 'replace_state', extractElementId(m[1]) || extractElementId(message));
  }

  // `delete` verb removing a node from the active state path => off air. Guard
  // on the path referencing an element id / LM-Line_* / transition-logic state
  // node so unrelated deletes can never fire a spurious off-air.
  m = message.match(/\bdelete\s+(\S+)/);
  if (m && /\/pilotdb\/elements\/\d+|LM-Line_\d+|transition_logic|\/state\/current\b/.test(m[1])) {
    return mk('out', extractLineName(m[1]), message, 'delete', 'delete_state', extractElementId(m[1]));
  }

  // ===== branch / KB fallback heuristics ====================================

  // Explicit out command form (director-with-out): .../<line>/current out
  m = message.match(/\bset text .+?\/([^/\s]+)\/current out\b/);
  if (m) return mk('out', m[1], message, 'set', 'out_command');

  // XML state definition form: STATE_<entry name="LINE">…<entry name="state">A|O</entry>
  if (message.includes('STATE_<entry name=') && /<entry name="state">[AO]<\/entry>/.test(message)) {
    const lineMatch = message.match(/STATE_<entry name="([^"]+)">/);
    const stateMatch = message.match(/<entry name="state">([AO])<\/entry>/);
    if (lineMatch && stateMatch) {
      return mk(stateMatch[1] === 'A' ? 'take' : 'out', lineMatch[1], message, 'set', 'xml_state');
    }
  }

  // System-log show/profile teardown (KB §4b): a definitive OUT that carries no
  // element id or line — the adapter attributes it to the active element.
  //   * set text /state/system/log {N}Cleaning up viz-handlers…show…profile…
  if (/Cleaning up viz-handlers/i.test(message)) {
    return mk('out', null, message, 'set', 'system_log_cleanup', extractElementId(message));
  }

  return null;
}

module.exports = { parseDirectorEvent, extractElementId, extractLineName };
