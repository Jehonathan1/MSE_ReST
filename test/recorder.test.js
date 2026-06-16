// test/recorder.test.js — run with: node --test
//
// Deterministic offline regression for the recorder's parse/join code and the
// replay harness, using the committed Stripe-lifecycle fixtures. This is the
// verifier that proves the Pilot-join code ahead of the live office capture.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  parsePilotElement,
  parseLastTakenElement,
  parseChannelState,
  resolveBasedOn,
  deriveVariant,
  deriveExclusive,
} = require('../src/recorder/parsers');
const { parseJsonl, reconstruct, replayFile, ReplayError } = require('../replay');
const { Recorder } = require('../src/recorder/recorder');

// In-memory JSONL writer so we can unit-test the recorder's join logic without
// touching the filesystem or a live MSE.
function memWriter() {
  return { filePath: '(mem)', count: 0, events: [], write(o) { this.events.push(o); this.count++; }, close() { return Promise.resolve(); } };
}
function baseCfg(over = {}) {
  return Object.assign({
    mseHost: '127.0.0.1', stompPort: 8582, actorPort: 8595, restPort: 8580,
    pilotHost: null, pilotPort: 8177, profile: null, channel: null,
    stripeTemplateId: '16082', line1Field: '0', line2Field: '1', exclusiveField: null,
    outDir: 'recordings', pollIntervalMs: 2000, contentPoll: true, storeRaw: true,
    durationSec: 0, pilotTimeoutMs: 5000,
  }, over);
}

const FIX = path.join(__dirname, 'fixtures', 'stripe-lifecycle.jsonl');
const FIX_TRUNC = path.join(__dirname, 'fixtures', 'stripe-lifecycle.truncated.jsonl');

// --- Pilot-join parser: parse(pilotXml) must equal the committed content -----

test('parsePilotElement reproduces the committed content for every take/change', () => {
  const events = parseJsonl(fs.readFileSync(FIX, 'utf8'));
  const joinEvents = events.filter((e) => e.type === 'take' || e.type === 'change');
  assert.ok(joinEvents.length >= 5, 'fixture should contain the full lifecycle');
  for (const e of joinEvents) {
    assert.ok(e.pilotXml, `event seq ${e.seq} must embed raw Pilot XML`);
    const parsed = parsePilotElement(e.pilotXml, e.elementId);
    assert.deepStrictEqual(parsed, e.content,
      `parse(pilotXml) must equal recorded content for seq ${e.seq}`);
  }
});

test('parsePilotElement: empty Line_2 stays a field but not a text', () => {
  const xml = '<entry><title>S</title><link rel="template" href="/templates/16082"/>'
    + '<field name="0"><value>hello</value></field><field name="1"><value></value></field></entry>';
  const c = parsePilotElement(xml, '1');
  assert.strictEqual(c.templateId, '16082');
  assert.deepStrictEqual(c.fields, { '0': 'hello', '1': '' });
  assert.deepStrictEqual(c.texts, ['hello']);
});

// --- variant / exclusive derivation -----------------------------------------

test('deriveVariant: ONE_LINE when Line_2 empty, TWO_LINE when populated', () => {
  assert.strictEqual(deriveVariant({ fields: { '0': 'a', '1': '' } }, '1'), 'ONE_LINE');
  assert.strictEqual(deriveVariant({ fields: { '0': 'a', '1': 'b' } }, '1'), 'TWO_LINE');
  // tolerate zero-padded field naming
  assert.strictEqual(deriveVariant({ fields: { '01': 'a', '02': 'b' } }, '2'), 'TWO_LINE');
});

test('deriveExclusive: only when an exclusive field is configured & non-empty', () => {
  assert.strictEqual(deriveExclusive({ fields: { '2': 'בלעדי' } }, '2'), true);
  assert.strictEqual(deriveExclusive({ fields: { '2': '' } }, '2'), false);
  assert.strictEqual(deriveExclusive({ fields: { '2': 'x' } }, null), null);
});

// --- reference parsing (state feed + actor) ---------------------------------

test('resolveBasedOn handles pilot element and template references', () => {
  assert.deepStrictEqual(
    resolveBasedOn('/something/pilotdb/elements/12345'),
    { elementId: '12345', templateId: null, isTemplate: false, basedOn: '/something/pilotdb/elements/12345' });
  const tl = resolveBasedOn('/x/16082/dataitems/last_open_template');
  assert.strictEqual(tl.elementId, '16082');
  assert.strictEqual(tl.isTemplate, true);
});

test('parseLastTakenElement extracts the pilot element id from a path', () => {
  const msg = '7 ok {60}<entry name="path">/x/external/pilotdb/elements/20001</entry>';
  const ref = parseLastTakenElement(msg);
  assert.strictEqual(ref.elementId, '20001');
  assert.strictEqual(ref.isTemplate, false);
  assert.strictEqual(parseLastTakenElement('6 error inexistent /state/last_taken_element'), null);
});

test('parseChannelState navigates transition_logic -> based_on', () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:state="http://www.vizrt.com/types/state">
    <entry><title>Main</title><content><state:channel>
      <state:layer name="middle" type="transition_logic">
        <state:transition_logic_layer based_on="/external/pilotdb/elements/20001"/>
      </state:layer></state:channel></content></entry></feed>`;
  const r = parseChannelState(xml);
  assert.strictEqual(r.channelName, 'Main');
  assert.strictEqual(r.active.length, 1);
  assert.strictEqual(r.active[0].elementId, '20001');
});

// --- replay reconstruction ---------------------------------------------------

test('replay reconstructs the full Stripe lifecycle correctly', () => {
  const result = replayFile(FIX);
  assert.strictEqual(result.stripe.length, 1, 'one Stripe instance');
  const inst = result.stripe[0];

  assert.strictEqual(inst.elementId, '20001');
  assert.strictEqual(inst.templateId, '16082');
  assert.strictEqual(inst.tookAt, '2026-06-16T18:00:05.050Z');
  assert.strictEqual(inst.leftAt, '2026-06-16T18:00:40.000Z');
  assert.strictEqual(inst.stillOnAir, false);

  const kinds = inst.timeline.map((t) => t.kind);
  assert.deepStrictEqual(kinds, ['take', 'change', 'change', 'change', 'change', 'off-air']);

  const onAir = inst.timeline.filter((t) => t.kind !== 'off-air');
  assert.deepStrictEqual(onAir.map((t) => t.variant),
    ['ONE_LINE', 'ONE_LINE', 'TWO_LINE', 'TWO_LINE', 'TWO_LINE']);
  assert.deepStrictEqual(onAir.map((t) => t.exclusive),
    [false, false, false, true, false]);

  // content at take-in (1-line) and after Line_2 populated (2-line)
  assert.deepStrictEqual(onAir[0].texts, ['ראש הממשלה נואם']);
  assert.deepStrictEqual(onAir[2].texts, ['ראש הממשלה נואם בכנסת', 'דיון על תקציב המדינה']);
});

// --- loud failure on truncated / incomplete recordings ----------------------

test('replay FAILS loudly on a truncated (mid-line) recording', () => {
  assert.throws(() => replayFile(FIX_TRUNC), ReplayError);
});

test('replay FAILS loudly on a dangling on-air element with no session stop', () => {
  const events = [
    { ts: 't0', seq: 0, source: 'recorder', type: 'session', event: 'start', config: { stripeTemplateId: '16082', line2Field: '1' } },
    { ts: 't1', seq: 1, source: 'actor', type: 'take', elementId: '20001', templateId: '16082', isStripe: true,
      content: { fields: { '0': 'x', '1': '' }, texts: ['x'], templateId: '16082' } },
    // no off-air, no session stop -> truncated
  ];
  assert.throws(() => reconstruct(events), ReplayError);
});

// --- recorder take path: contentPending when no Pilot host --------------------

test('recorder records a take as contentPending:true when no Pilot host (home)', async () => {
  const writer = memWriter();
  const rec = new Recorder(baseCfg({ pilotHost: null }), { writer, logger: () => {}, now: () => 't' });
  await rec._onTakeSignal({ elementId: '20001', basedOn: '/external/pilotdb/elements/20001', isTemplate: false }, 'actor');
  const take = writer.events.find((e) => e.type === 'take');
  assert.ok(take, 'a take event must be recorded');
  assert.strictEqual(take.contentPending, true);
  assert.strictEqual(take.content, null);
  assert.strictEqual(take.elementId, '20001');
  assert.strictEqual(take.basedOn, '/external/pilotdb/elements/20001');
  assert.strictEqual(take.variant, null); // unknown until content resolves at work
});

test('replay accepts a still-on-air element when the session closed cleanly', () => {
  const events = [
    { ts: 't0', seq: 0, source: 'recorder', type: 'session', event: 'start', config: { stripeTemplateId: '16082', line2Field: '1' } },
    { ts: 't1', seq: 1, source: 'actor', type: 'take', elementId: '20001', templateId: '16082', isStripe: true,
      content: { fields: { '0': 'x', '1': '' }, texts: ['x'], templateId: '16082' } },
    { ts: 't2', seq: 2, source: 'recorder', type: 'session', event: 'stop' },
  ];
  const result = reconstruct(events);
  assert.strictEqual(result.stripe.length, 1);
  assert.strictEqual(result.stripe[0].stillOnAir, true);
});
