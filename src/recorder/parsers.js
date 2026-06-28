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

// --- MSE element node (<entry name="data"> live working copy) --------------

// Isolate the FIRST `<entry name="data">…</entry>` block, depth-aware so nested
// `<entry>` subnodes inside it are kept and sibling blocks (schema, viz) are not.
// Returns the inner XML or null when there is no data entry.
function extractDataEntry(xml) {
  if (!xml) return null;
  const open = xml.match(/<entry\s+name="data"\s*>/);
  if (!open) return null;
  const start = open.index + open[0].length;
  const tokenRe = /<entry\b[^>]*>|<\/entry>/g;
  tokenRe.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = tokenRe.exec(xml)) !== null) {
    if (m[0] === '</entry>') {
      depth -= 1;
      if (depth === 0) return xml.slice(start, m.index);
    } else if (!m[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return xml.slice(start); // unbalanced — return the remainder defensively
}

// Parse an MSE element-node payload (a PepTalk `get` body) into the SAME content
// shape as parsePilotElement, sourcing the live on-air values from the element's
// `<entry name="data">` numeric leaf subnodes.
//
// Why: an on-air text edit updates the LIVE MSE document, NOT the saved Pilot DB
// element (shoot §8.3 — the Pilot element stays byte-identical, same etag). The
// edited values surface on the element node's data subnodes, exactly as the
// Media Sequencer document & API §"Live Update Support" describes ("the element
// data entries (data subnodes) will be filled in with the updated payload field
// values", l.1009; created-element example l.4830).
//
// Field indexing: the 4-layer model's data subnodes are 1-indexed (`<entry
// name="1">` = first field), while the recorder/Pilot convention is 0-indexed
// (line1Field=0, line2Field=1). A numeric name N is therefore normalized to N-1
// (leading zeros tolerated: "01" == "1"), so MSE content is directly comparable
// to Pilot content and variant-derivable with the same line2Field. Only numeric
// leaf fields are captured (text leaves) — confirm the exact data-subnode shape /
// index base on the next live trip (see RECORDER.md; this fix is unconfirmed live).
function parseMseElementData(xmlString, elementId = null) {
  const data = {
    elementId: elementId,
    templateId: null,
    templateName: 'MSE Element',
    fields: {},
    texts: [],
  };
  if (!xmlString) return data;

  try {
    const tplMatch = xmlString.match(/master_templates\/(\d+)/)
      || xmlString.match(/\/templates\/(\d+)/)
      || xmlString.match(/<entry name="template_id">\s*(\d+)\s*<\/entry>/);
    if (tplMatch) data.templateId = tplMatch[1];

    const block = extractDataEntry(xmlString);
    if (block != null) {
      // The LIVE data block nests each field as an outer wrapper entry whose only
      // child is the value leaf, e.g.:
      //   <entry description="Line_1" name="01">
      //     <entry description="Line_1" singleline="true" type="text" name="01">VALUE</entry>
      //   </entry>
      // Two things the Stage-1 regex got wrong on the real wire (shoot §8.3 / STEP 3):
      //   1. `name` is NOT the first attribute (`description` precedes it), so a
      //      `<entry name="…"` anchored match never fired -> empty fields -> no
      //      change ever detected on an on-air edit.
      //   2. The value lives on the inner text LEAF, not the wrapper.
      // So match every entry tag regardless of attribute order, read `name` out of
      // its attribute list, and keep only leaves that carry direct text (`[^<]+`).
      // The wrappers have a child element immediately after `>` (no direct text),
      // so they never match and are skipped naturally.
      const leafRe = /<entry\b([^>]*)>([^<]+)<\/entry>/g;
      let m;
      while ((m = leafRe.exec(block)) !== null) {
        const nameMatch = m[1].match(/\bname="0*(\d+)"/);
        if (!nameMatch) continue;
        const idx = Number(nameMatch[1]);
        if (!Number.isFinite(idx) || idx < 1) continue; // 4-layer fields are 1-indexed
        const name = String(idx - 1); // 1-indexed MSE -> 0-indexed recorder/Pilot
        const value = decodeEntities(m[2].trim());
        data.fields[name] = value;
        if (value) data.texts.push(value);
      }
    }
    return data;
  } catch (err) {
    return data;
  }
}

// Extract the element id a LIVE MSE element node names itself with — the `name`
// attribute on the root `<element>` tag (confirmed live: `<element name="2380782">`
// in stripe-onair-edit.mse / stripe-restripe). Used to verify a working-instance
// read actually BELONGS to the element it was fetched for: last_taken /
// last_open_template lags a stripe->stripe switch and can name the OUTGOING
// element's working copy, so the node's own identity is the authority (the path
// segment's element/template semantics are not relied upon). Returns null if the
// node carries no `<element name>` (then the caller falls back to trusting the read).
function parseMseElementName(xmlString) {
  if (!xmlString) return null;
  const m = xmlString.match(/<element\b[^>]*\bname="([^"]+)"/);
  return m ? m[1] : null;
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
// Line_2 is empty — exactly as the real line2Change script decides (viz-to-gsap
// convergence model). Derive from the normalized texts[] (a verbatim mirror of the
// viz-to-gsap live-mapper): texts holds only non-empty field values in field order,
// so a present, non-empty texts[1] IS a populated Line_2. This avoids the 0-based vs
// 1-based field-index bug — getField(line2Field='1') pads to "01", which on 1-based
// Pilot content is LINE_1, mislabelling every such element TWO_LINE (night-61b). The
// getField fallback is kept for content that carries fields but no texts[].
function deriveVariant(content, line2Field = '1') {
  if (!content) return null;
  if (Array.isArray(content.texts)) {
    const l2 = content.texts.length >= 2 ? content.texts[1] : '';
    return l2 && String(l2).trim() ? 'TWO_LINE' : 'ONE_LINE';
  }
  if (!content.fields) return null;
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
  parseMseElementData,
  parseMseElementName,
  extractDataEntry,
  parseLastTakenElement,
  resolveBasedOn,
  parseChannelState,
  deriveVariant,
  deriveExclusive,
  contentSignature,
};
