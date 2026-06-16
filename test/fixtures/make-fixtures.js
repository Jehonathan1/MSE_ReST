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
const { Recorder } = require('../../src/recorder/recorder');

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

// --- stripe-takeout fixture: the Director (actor) off-air detection path ------
//
// Two committed files:
//   stripe-takeout.actor.json — the raw actor *director-stream* messages that
//     script a take-in (A + last_taken) -> take-out (O). This is the detection
//     INPUT; the recorder.test.js feeds it to a Recorder and asserts an off-air.
//   stripe-takeout.jsonl — the recorder's OUTPUT when driven by that script
//     (Pilot join stubbed to Stripe content), so `node replay.js` can replay it.
//
// The A/O state lives on the element's scheduler line path, independent of the
// channel name — the whole point of Stage 2b.

const TAKEOUT_LINE_PATH = `/scheduler/viz_program/external/pilotdb/elements/${ELEMENT_ID}/handler/data/lines/LM-Line_1`;
const actorMessages = [
  // take-in: A state on the line (sets the active element) ...
  `* set text ${TAKEOUT_LINE_PATH}/state/current A`,
  // ... and the last_taken_element signal the recorder joins Pilot content on.
  `* set text /state/last_taken_element {64}<entry name="path">/external/pilotdb/elements/${ELEMENT_ID}</entry>`,
  // take-out: O state on the same line -> off-air (no channel name involved).
  `* set text ${TAKEOUT_LINE_PATH}/state/current O`,
];
fs.writeFileSync(path.join(dir, 'stripe-takeout.actor.json'), JSON.stringify(actorMessages, null, 2) + '\n');

// Drive a real Recorder over the actor script with the Pilot join stubbed to
// Stripe content, then commit its JSONL output. Mirrors what recorder.test.js
// asserts, so the committed file is genuine recorder output, not hand-authored.
async function makeTakeout() {
  const events = [];
  const writer = { filePath: '(mem)', count: 0, write(o) { events.push(o); this.count++; }, close() { return Promise.resolve(); } };
  let t = 0;
  const now = () => `2026-06-16T19:00:${String(t++).padStart(2, '0')}.000Z`;
  const cfg = {
    mseHost: '127.0.0.1', stompPort: 8582, actorPort: 8595, restPort: 8580,
    pilotHost: '10.0.0.5', pilotPort: 8177, profile: 'Office', channel: 'Main', source: 'director',
    stripeTemplateId: TEMPLATE_ID, line1Field: '0', line2Field: '1', exclusiveField: '2',
    outDir: 'recordings', pollIntervalMs: 2000, contentPoll: false, storeRaw: true,
    durationSec: 0, pilotTimeoutMs: 5000,
  };
  const rec = new Recorder(cfg, { writer, logger: () => {}, now });
  const stripeContent = content(L1a, '', ''); // 1-line Stripe, templateId 16082
  rec._fetchContent = async () => ({ content: stripeContent, pending: false, error: null, raw: pilotXml(L1a, '', '') });

  rec._record({
    source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: {
      mseHost: cfg.mseHost, stompPort: cfg.stompPort, actorPort: cfg.actorPort, restPort: cfg.restPort,
      pilotHost: cfg.pilotHost, pilotPort: cfg.pilotPort, profile: cfg.profile, channel: cfg.channel, source: cfg.source,
      stripeTemplateId: cfg.stripeTemplateId, line1Field: cfg.line1Field, line2Field: cfg.line2Field, exclusiveField: cfg.exclusiveField,
    },
  });
  for (const msg of actorMessages) {
    rec.adapters.forEach((a) => { if (a.needsActor) a.handleActorMessage(msg); });
    await new Promise((r) => setImmediate(r)); // let the async take's Pilot join settle before the next msg
  }
  rec._record({ source: 'recorder', type: 'session', event: 'stop', eventCount: writer.count });

  const lines = events.map((e) => JSON.stringify(e));
  const takeoutPath = path.join(dir, 'stripe-takeout.jsonl');
  fs.writeFileSync(takeoutPath, lines.join('\n') + '\n');
  console.log(`wrote ${takeoutPath} (${lines.length} events) + stripe-takeout.actor.json`);
}

// --- Stage 2c: shared fixture drivers ----------------------------------------
//
// Each driver runs a REAL Recorder (Pilot join stubbed) over a scripted input and
// commits both the detection INPUT and the recorder's JSONL OUTPUT, so the tests
// assert against genuine recorder behaviour and replay.js reconstructs the file.

const TEMPLATE_NONSTRIPE = '99999';

function baseFixtureCfg(over = {}) {
  return Object.assign({
    mseHost: '127.0.0.1', stompPort: 8582, actorPort: 8595, restPort: 8580,
    pilotHost: '10.0.0.5', pilotPort: 8177, profile: 'Office', channel: 'Main',
    stripeTemplateId: TEMPLATE_ID, line1Field: '0', line2Field: '1', exclusiveField: '2',
    outDir: 'recordings', pollIntervalMs: 2000, contentPoll: false, storeRaw: true,
    durationSec: 0, pilotTimeoutMs: 5000, channelStateTimeoutMs: 60000,
  }, over);
}

function sessionStart(cfg) {
  return {
    source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: {
      mseHost: cfg.mseHost, stompPort: cfg.stompPort, actorPort: cfg.actorPort, restPort: cfg.restPort,
      pilotHost: cfg.pilotHost, pilotPort: cfg.pilotPort, profile: cfg.profile, channel: cfg.channel,
      source: cfg.source, channelStateTimeoutMs: cfg.channelStateTimeoutMs,
      stripeTemplateId: cfg.stripeTemplateId, line1Field: cfg.line1Field, line2Field: cfg.line2Field, exclusiveField: cfg.exclusiveField,
    },
  };
}

function memEvents() {
  const events = [];
  return { events, writer: { filePath: '(mem)', count: 0, write(o) { events.push(o); this.count++; }, close() { return Promise.resolve(); } } };
}

const tick = () => new Promise((r) => setImmediate(r));

// Drive a director scenario (source 'director') over scripted actor messages.
async function driveDirector(name, actorMessages, minute) {
  const { events, writer } = memEvents();
  let t = 0;
  const now = () => `2026-06-16T19:${minute}:${String(t++).padStart(2, '0')}.000Z`;
  const cfg = baseFixtureCfg({ source: 'director' });
  const rec = new Recorder(cfg, { writer, logger: () => {}, now });
  // 1-line Stripe content for the Stripe element; non-stripe for anything else.
  rec._fetchContent = async (id) => (String(id) === ELEMENT_ID
    ? { content: content(L1a, '', ''), pending: false, error: null, raw: pilotXml(L1a, '', '') }
    : { content: { elementId: String(id), templateId: TEMPLATE_NONSTRIPE, templateName: 'Other', fields: {}, texts: [] }, pending: false, error: null, raw: '<other/>' });

  rec._record(sessionStart(cfg));
  for (const msg of actorMessages) {
    rec.adapters.forEach((a) => { if (a.needsActor) a.handleActorMessage(msg); });
    await tick();
  }
  rec._record({ source: 'recorder', type: 'session', event: 'stop', eventCount: writer.count });

  fs.writeFileSync(path.join(dir, `${name}.actor.json`), JSON.stringify(actorMessages, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`wrote ${name}.actor.json + ${name}.jsonl (${events.length} events)`);
}

// A channel-state feed body with the given pilot element ids in the active
// transition_logic layer (empty = nothing on air).
function channelStateXml(ids) {
  const layers = ids.map((id) => `<state:transition_logic_layer based_on="/external/pilotdb/elements/${id}"/>`).join('');
  return '<?xml version="1.0"?>'
    + '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:state="http://www.vizrt.com/types/state">'
    + `<entry><title>Main</title><content><state:channel>`
    + `<state:layer name="middle" type="transition_logic">${layers}</state:layer>`
    + '</state:channel></content></entry></feed>';
}

// Drive a Trio scenario (source 'trio'): channel-state take-in -> Pilot content
// change while on air -> channel-state take-out (drops from the active set).
async function makeTrio() {
  const { events, writer } = memEvents();
  let t = 0;
  const now = () => `2026-06-16T19:40:${String(t++).padStart(2, '0')}.000Z`;
  const cfg = baseFixtureCfg({ source: 'trio' });
  const rec = new Recorder(cfg, { writer, logger: () => {}, now });
  let cur = { content: content(L1a, '', ''), pending: false, error: null, raw: pilotXml(L1a, '', '') };
  rec._fetchContent = async () => cur;

  rec._record(sessionStart(cfg));
  const trio = rec.adapters.find((a) => a.source === 'trio');
  const bodyIn = channelStateXml([ELEMENT_ID]);
  const bodyOut = channelStateXml([]);

  trio.handleChannelState(bodyIn);                                  // take-in (1-line)
  await tick();
  cur = { content: content(L1b, L2, ''), pending: false, error: null, raw: pilotXml(L1b, L2, '') };
  await rec._refreshOnAirContent();                                 // Pilot change -> 2-line
  trio.handleChannelState(bodyOut);                                 // take-out (set empties)
  await tick();
  rec._record({ source: 'recorder', type: 'session', event: 'stop', eventCount: writer.count });

  fs.writeFileSync(path.join(dir, 'stripe-trio.channelstate.json'), JSON.stringify([bodyIn, bodyOut], null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'stripe-trio.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`wrote stripe-trio.channelstate.json + stripe-trio.jsonl (${events.length} events)`);
}

// Scheduler line paths: one carrying the element id, one without it.
const LINE_WITH_ID = `/scheduler/viz_program/external/pilotdb/elements/${ELEMENT_ID}/handler/data/lines/LM-Line_1`;
const LINE_NO_ID = '/scheduler/viz_program/show/data/lines/LM-Line_1';
const LAST_TAKEN = `* set text /state/last_taken_element {64}<entry name="path">/external/pilotdb/elements/${ELEMENT_ID}</entry>`;

async function main() {
  await makeTakeout();
  // (i) /state/system/log cleanup-driven OUT (no element id / line -> active element).
  await driveDirector('stripe-cleanup', [
    `* set text ${LINE_WITH_ID}/state/current A`,
    LAST_TAKEN,
    '* set text /state/system/log {72}Cleaning up viz-handlers for show /storage/shows/Brand on profile Brand',
  ], '20');
  // (ii) ID-less OUT resolved by scheduler line name (the O carries no element id).
  await driveDirector('stripe-byline', [
    `* set text ${LINE_WITH_ID}/state/current A`,
    LAST_TAKEN,
    `* set text ${LINE_NO_ID}/state/current O`,
  ], '30');
  // Official `delete` verb OUT (a node removed from the active state path).
  await driveDirector('stripe-delete', [
    `* set text ${LINE_WITH_ID}/state/current A`,
    LAST_TAKEN,
    `* delete ${LINE_WITH_ID}`,
  ], '50');
  await makeTrio();
}

main().catch((err) => { console.error(err); process.exit(1); });
