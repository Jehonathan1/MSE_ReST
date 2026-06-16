// test/fixtures/make-fixtures.js
//
// Deterministically generate the committed Stripe-lifecycle fixtures. Run with:
//   node test/fixtures/make-fixtures.js
//
// The fixtures embed raw Pilot element XML alongside the resolved `content`, so
// the regression test can prove the Pilot-join parser (parsePilotElement) against
// committed ground truth, and replay.js can reconstruct the timeline offline.
//
// All content objects are authored BY HAND here (not via parsePilotElement) so
// the test's assertion parse(pilotXml) === content is an independent check.

const fs = require('fs');
const path = require('path');

const ELEMENT_ID = '20001';
const TEMPLATE_ID = '16082';

// Build a Pilot data element XML for given Line_1 / Line_2 / exclusive values.
function pilotXml(line1, line2, exclusive) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<entry xmlns="http://www.w3.org/2005/Atom">',
    '  <title>Stripe</title>',
    `  <link rel="template" href="http://pilot:8177/templates/${TEMPLATE_ID}"/>`,
    '  <content type="application/vnd.vizrt.payload+xml">',
    '    <payload>',
    `      <field name="0"><value>${line1}</value></field>`,
    `      <field name="1"><value>${line2}</value></field>`,
    `      <field name="2"><value>${exclusive}</value></field>`,
    '    </payload>',
    '  </content>',
    '</entry>',
  ].join('\n');
}

// Author the expected parsed content by hand (independent of the parser).
function content(line1, line2, exclusive) {
  const fields = { '0': line1, '1': line2, '2': exclusive };
  const texts = [line1, line2, exclusive].filter((v) => v && v.length > 0);
  return { elementId: ELEMENT_ID, templateId: TEMPLATE_ID, templateName: 'Stripe', fields, texts };
}

// Stripe field values across the lifecycle (Hebrew, as in the real graphics).
const L1a = 'ראש הממשלה נואם';
const L1b = 'ראש הממשלה נואם בכנסת';
const L2 = 'דיון על תקציב המדינה';
const EXCL = 'בלעדי';

function take(ts, source, c, x) {
  return {
    ts, seq: undefined, source, type: 'take',
    elementId: ELEMENT_ID, templateId: TEMPLATE_ID, isTemplate: false,
    basedOn: `/external/pilotdb/elements/${ELEMENT_ID}`,
    isStripe: true, content: c, contentPending: false, contentError: null,
    variant: c.fields['1'] ? 'TWO_LINE' : 'ONE_LINE',
    exclusive: !!c.fields['2'], pilotXml: x,
  };
}
function change(ts, c, x) {
  return {
    ts, source: 'pilot', type: 'change',
    elementId: ELEMENT_ID, templateId: TEMPLATE_ID, isStripe: true,
    content: c, contentPending: false,
    variant: c.fields['1'] ? 'TWO_LINE' : 'ONE_LINE',
    exclusive: !!c.fields['2'], pilotXml: x,
  };
}

const events = [
  { ts: '2026-06-16T18:00:00.000Z', source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { mseHost: '127.0.0.1', stompPort: 8582, actorPort: 8595, restPort: 8580,
      pilotHost: '10.0.0.5', pilotPort: 8177, profile: 'Office', channel: 'Main',
      stripeTemplateId: TEMPLATE_ID, line1Field: '0', line2Field: '1', exclusiveField: '2' } },
  { ts: '2026-06-16T18:00:00.100Z', source: 'actor', type: 'status', event: 'connected' },
  { ts: '2026-06-16T18:00:00.200Z', source: 'stomp', type: 'status', event: 'connected' },
  // Stripe enters the active set, then take-in as a 1-line.
  { ts: '2026-06-16T18:00:05.000Z', source: 'stomp', type: 'state', channel: 'Main',
    active: [{ elementId: ELEMENT_ID, templateId: null, isTemplate: false }] },
  take('2026-06-16T18:00:05.050Z', 'actor', content(L1a, '', ''), pilotXml(L1a, '', '')),
  // Change Line_1 while on air (still 1-line).
  change('2026-06-16T18:00:12.000Z', content(L1b, '', ''), pilotXml(L1b, '', '')),
  // Line_2 populated -> 2-line.
  change('2026-06-16T18:00:20.000Z', content(L1b, L2, ''), pilotXml(L1b, L2, '')),
  // Exclusive badge ON, then OFF.
  change('2026-06-16T18:00:27.000Z', content(L1b, L2, EXCL), pilotXml(L1b, L2, EXCL)),
  change('2026-06-16T18:00:34.000Z', content(L1b, L2, ''), pilotXml(L1b, L2, '')),
  // Take-out: layer empties.
  { ts: '2026-06-16T18:00:40.000Z', source: 'stomp', type: 'off-air',
    elementId: ELEMENT_ID, templateId: TEMPLATE_ID, isStripe: true },
  { ts: '2026-06-16T18:00:40.100Z', source: 'stomp', type: 'state', channel: 'Main', active: [] },
  { ts: '2026-06-16T18:00:45.000Z', source: 'recorder', type: 'session', event: 'stop', eventCount: 11 },
];

// Assign sequence numbers like the live recorder does.
events.forEach((e, i) => { e.seq = i; });

const dir = __dirname;
const fullPath = path.join(dir, 'stripe-lifecycle.jsonl');
const fullLines = events.map((e) => JSON.stringify(e));
fs.writeFileSync(fullPath, fullLines.join('\n') + '\n');
console.log(`wrote ${fullPath} (${fullLines.length} events)`);

// Truncated fixture: keep through the first change, then cut the next line in
// half so JSON.parse fails — a deliberately corrupt/incomplete recording.
const truncPath = path.join(dir, 'stripe-lifecycle.truncated.jsonl');
const keep = fullLines.slice(0, 6); // session..first change
const half = fullLines[6].slice(0, Math.floor(fullLines[6].length / 2)); // cut mid-JSON
fs.writeFileSync(truncPath, keep.join('\n') + '\n' + half);
console.log(`wrote ${truncPath} (truncated mid-line)`);
