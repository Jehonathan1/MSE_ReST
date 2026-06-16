// src/recorder/parsers.js
//
// Pure parse + derive functions shared by the recorder, the replay harness, and
// the regression test. These are the proven parsing rules lifted verbatim from
// the existing monitor (websocketServer.js / stompClient.js) so the recorder
// reuses the connection-tested logic rather than reinventing it.
//
// Everything here is synchronous and side-effect free — that is what makes the
// Pilot-join code testable offline against committed fixture XML.

const { parseString } = require('xml2js');

// --- text helpers ----------------------------------------------------------

// Decode the handful of XML/HTML entities the Pilot/VDOM payloads carry, exactly
// as processTextForTransmission() does in websocketServer.js.
function decodeEntities(text) {
  if (!text) return '';
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'");
}

// Look up a numeric field tolerating zero-padding ("1" vs "01") since Pilot and
// the VDOM disagree on padding for the same Line_N field.
function getField(fields, name) {
  if (fields == null || name == null) return undefined;
  const n = String(name);
  if (fields[n] !== undefined) return fields[n];
  const padded = n.padStart(2, '0');
  if (fields[padded] !== undefined) return fields[padded];
  const unpadded = String(Number(n));
  if (fields[unpadded] !== undefined) return fields[unpadded];
  return undefined;
}

// --- Pilot element (8177 /dataelements/<id>) -------------------------------

// Parse a Pilot data element XML into {templateId, templateName, fields{}, texts[]}.
// Ported from parsePilotElementData() in websocketServer.js — same regexes, so the
// recorder's live join and this offline parse are identical code paths.
function parsePilotElement(xmlString, elementId = null) {
  const data = {
    elementId: elementId,
    templateId: null,
    templateName: 'Unknown Template',
    fields: {},
    texts: [],
  };
  if (!xmlString) return data;

  try {
    const templateLinkMatch = xmlString.match(/<link rel="template"[^>]*href="[^"]*\/templates\/([^"]+)"/);
    if (templateLinkMatch) data.templateId = templateLinkMatch[1];

    const titleMatch = xmlString.match(/<title[^>]*>([^<]+)<\/title>/);
    if (titleMatch) data.templateName = decodeEntities(titleMatch[1]);

    // <field name="0"><value>...</value></field> — numeric fields only.
    const fieldMatches = xmlString.match(/<field name="(\d+)">\s*<value>([^<]*)<\/value>\s*<\/field>/g);
    if (fieldMatches) {
      fieldMatches.forEach((m) => {
        const nameMatch = m.match(/name="(\d+)"/);
        const valueMatch = m.match(/<value>([^<]*)<\/value>/);
        if (nameMatch && valueMatch) {
          const name = nameMatch[1];
          const value = decodeEntities(valueMatch[1].trim());
          if (/^\d+$/.test(name)) {
            data.fields[name] = value;
            if (value) data.texts.push(value);
          }
        }
      });
    }
    return data;
  } catch (err) {
    return data;
  }
}

// --- Actor /state/last_taken_element ---------------------------------------

// Extract the element reference from a PepTalk actor reply containing
// <entry name="path">...</entry>. Returns null if no path is present.
// Ported from handleLastTakenElement() in websocketServer.js.
function parseLastTakenElement(message) {
  if (!message) return null;
  const pathMatch = message.match(/<entry name="path">([^<]+)<\/entry>/);
  if (!pathMatch) return null;
  const path = pathMatch[1];

  if (path.includes('/external/pilotdb/elements/')) {
    return { elementId: path.split('/').pop(), isTemplate: false, path };
  }
  if (path.includes('/dataitems/last_open_template')) {
    const idMatch = path.match(/\/last_open_template\/(\d+)/);
    return { elementId: idMatch ? idMatch[1] : null, isTemplate: true, path };
  }
  // Unknown shape — still return the raw path so callers can log it.
  return { elementId: path.split('/').pop() || null, isTemplate: false, path };
}

// --- STOMP channel-state feed ----------------------------------------------

// Resolve a single `based_on` reference to {elementId, templateId, isTemplate}.
// Ported from processChannelState() in stompClient.js.
function resolveBasedOn(basedOn) {
  if (!basedOn) return null;
  const pilotMatch = basedOn.match(/\/pilotdb\/elements\/(\d+)/);
  if (pilotMatch) {
    return { elementId: pilotMatch[1], templateId: null, isTemplate: false, basedOn };
  }
  if (basedOn.includes('/dataitems/last_open_template')) {
    const templateMatch = basedOn.match(/\/(\d+)\/dataitems\/last_open_template/);
    if (templateMatch) {
      return { elementId: templateMatch[1], templateId: templateMatch[1], isTemplate: true, basedOn };
    }
  }
  return null;
}

// Parse a channel-state feed body into {channelName, active:[{elementId,...}]}.
// Walks feed.entry[].content['state:channel'].state:layer(name=middle,
// type=transition_logic).state:transition_logic_layer[].@based_on — the exact
// path stompClient.js/websocketServer.js navigate.
function parseChannelState(xmlBody) {
  const out = { channelName: null, active: [] };
  if (!xmlBody) return out;

  let parsed = null;
  // xml2js parseString is synchronous for string input; capture via callback.
  parseString(xmlBody, { explicitArray: false }, (err, result) => {
    if (!err) parsed = result;
  });
  if (!parsed || !parsed.feed) return out;

  const entries = parsed.feed.entry
    ? (Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry])
    : [];

  for (const entry of entries) {
    if (entry && entry.title && !out.channelName) out.channelName = entry.title;
    const channel = entry && entry.content && entry.content['state:channel'];
    if (!channel) continue;

    const layers = channel['state:layer'];
    if (!layers) continue;
    const layerList = Array.isArray(layers) ? layers : [layers];

    for (const layer of layerList) {
      if (!(layer.$ && layer.$.name === 'middle' && layer.$.type === 'transition_logic')) continue;
      const tl = layer['state:transition_logic_layer'];
      if (!tl) continue;
      const tlList = Array.isArray(tl) ? tl : [tl];
      for (const tlLayer of tlList) {
        const basedOn = tlLayer && tlLayer.$ && tlLayer.$.based_on;
        const resolved = resolveBasedOn(basedOn);
        if (resolved) out.active.push(resolved);
      }
    }
  }
  return out;
}

// --- variant / exclusive derivation ----------------------------------------

// Derive the Stripe variant from content. 1-line vs 2-line is decided by whether
// the Line_2 field is empty — exactly as the real line2Change script decides
// (see viz-to-gsap convergence model).
function deriveVariant(content, line2Field = '1') {
  if (!content || !content.fields) return null;
  const v = getField(content.fields, line2Field);
  return v && String(v).trim() ? 'TWO_LINE' : 'ONE_LINE';
}

// Derive the exclusive ("בלעדי") badge state from a configurable field.
// Returns null when no exclusive field is configured.
function deriveExclusive(content, exclusiveField) {
  if (!exclusiveField || !content || !content.fields) return null;
  const v = getField(content.fields, exclusiveField);
  return !!(v && String(v).trim());
}

// Stable signature of a content's text payload, used to detect a "change" while
// an element stays on air (Line_1/Line_2/exclusive edits).
function contentSignature(content) {
  if (!content || !content.fields) return '';
  return Object.keys(content.fields)
    .sort()
    .map((k) => `${k}=${content.fields[k]}`)
    .join('');
}

module.exports = {
  decodeEntities,
  getField,
  parsePilotElement,
  parseLastTakenElement,
  resolveBasedOn,
  parseChannelState,
  deriveVariant,
  deriveExclusive,
  contentSignature,
};
