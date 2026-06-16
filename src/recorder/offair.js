// src/recorder/offair.js
//
// Pure detection of take/out actions from the actor *director* stream. Ported
// from checkForOffAirActions() + the A/O direct-state parsing in
// director-with-out:src/server/websocket/websocketServer.js, distilled to the
// definitive rules and stripped of all broadcast/POST/UI concerns.
//
// The director stream carries an element's on-air state as a single letter on
// its scheduler-tree line path:
//
//   .../<line>/state/current A   => taken  (on air)
//   .../<line>/state/current O   => out    (off air)
//   .../<line>/current out       => explicit out command
//   STATE_<entry name="<line>">...<entry name="state">A|O</entry>  (XML form)
//
// This signal is keyed on the element path in the scheduler tree, NOT on the MSE
// channel *name* — which is exactly why it stays reliable when the STOMP
// per-channel subscription is misconfigured (the Stage-1 work capture's failure
// mode). The rule is simply: stateValue === 'A' ⇒ take, anything else ⇒ out.
//
// Everything here is synchronous and side-effect free, so it is testable offline
// against committed fixture strings.

// Element id appears as .../pilotdb/elements/<id> (with or without /external).
const ELEMENT_ID_RE = /\/pilotdb\/elements\/(\d+)/;

function extractElementId(message) {
  if (!message) return null;
  const m = message.match(ELEMENT_ID_RE);
  return m ? m[1] : null;
}

function lineNumberOf(lineName) {
  const m = lineName && lineName.match(/LM-Line_(\d+)/);
  return m ? m[1] : null;
}

// Parse one actor message for a take/out action. Returns
//   { action: 'take' | 'out', lineName, lineNumber, elementId, rule }
// or null when the message carries no director state action.
//
// `elementId` is whatever the message itself names; it may be null (the caller
// then attributes the action to the current active element, as the source does).
function parseDirectorEvent(message) {
  if (!message) return null;

  // 1. Direct A/O state setting: "set text .../<line>/state/current A|O"
  let m = message.match(/set text .+\/([^/]+)\/state\/current ([AO])\b/);
  if (m) {
    const lineName = m[1];
    return {
      action: m[2] === 'A' ? 'take' : 'out',
      lineName,
      lineNumber: lineNumberOf(lineName),
      elementId: extractElementId(message),
      rule: 'state_AO',
    };
  }

  // 2. Explicit out command: "set text .../<line>/current out"
  m = message.match(/set text .+\/([^/]+)\/current out\b/);
  if (m) {
    const lineName = m[1];
    return {
      action: 'out',
      lineName,
      lineNumber: lineNumberOf(lineName),
      elementId: extractElementId(message),
      rule: 'out_command',
    };
  }

  // 3. XML state definition: STATE_<entry name="<line>">...<entry name="state">A|O</entry>
  if (message.includes('STATE_<entry name=') && /<entry name="state">[AO]<\/entry>/.test(message)) {
    const lineMatch = message.match(/STATE_<entry name="([^"]+)">/);
    const stateMatch = message.match(/<entry name="state">([AO])<\/entry>/);
    if (lineMatch && stateMatch) {
      const lineName = lineMatch[1];
      return {
        action: stateMatch[1] === 'A' ? 'take' : 'out',
        lineName,
        lineNumber: lineNumberOf(lineName),
        elementId: extractElementId(message),
        rule: 'xml_state',
      };
    }
  }

  return null;
}

module.exports = { parseDirectorEvent, extractElementId };
