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
const { parseDirectorEvent } = require('../src/recorder/offair');
const { DirectorAdapter, buildAdapters } = require('../src/recorder/adapters');

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
const FIX_TAKEOUT_ACTOR = path.join(__dirname, 'fixtures', 'stripe-takeout.actor.json');
const FIX_TAKEOUT = path.join(__dirname, 'fixtures', 'stripe-takeout.jsonl');

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

// --- Stage 2b: Director-stream off-air detection -----------------------------

test('parseDirectorEvent: A=take, O=out, explicit out; element id + line extracted', () => {
  const a = parseDirectorEvent('* set text /scheduler/x/external/pilotdb/elements/20001/lines/LM-Line_1/state/current A');
  assert.strictEqual(a.action, 'take');
  assert.strictEqual(a.elementId, '20001');
  assert.strictEqual(a.lineNumber, '1');

  const o = parseDirectorEvent('* set text /scheduler/x/external/pilotdb/elements/20001/lines/LM-Line_1/state/current O');
  assert.strictEqual(o.action, 'out');
  assert.strictEqual(o.elementId, '20001');

  const oc = parseDirectorEvent('* set text /scheduler/x/lines/LM-Line_2/current out');
  assert.strictEqual(oc.action, 'out');
  assert.strictEqual(oc.lineNumber, '2');

  // XML form, and a non-matching message.
  const xml = parseDirectorEvent('... STATE_<entry name="LM-Line_1"> ... <entry name="state">O</entry> ...');
  assert.strictEqual(xml.action, 'out');
  assert.strictEqual(parseDirectorEvent('* set text /foo/bar baz'), null);
});

test('DirectorAdapter: take via last_taken, then an out with no element id attributes to it', () => {
  const a = new DirectorAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const takes = []; const offs = [];
  a.on('take', (r) => takes.push(r));
  a.on('off-air', (o) => offs.push(o));

  a.handleActorMessage('* set text /x/last_taken_element {1}<entry name="path">/external/pilotdb/elements/20001</entry>');
  assert.strictEqual(takes.length, 1);
  assert.strictEqual(takes[0].elementId, '20001');

  // an O with no element id in the message -> attributed to the active element
  a.handleActorMessage('* set text /scheduler/x/lines/LM-Line_1/state/current O');
  assert.strictEqual(offs.length, 1);
  assert.strictEqual(offs[0].elementId, '20001');
});

test('DirectorAdapter off-air does NOT depend on the channel name', () => {
  // The line path carries no channel name at all, yet the out is still detected.
  const a = new DirectorAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const offs = [];
  a.on('off-air', (o) => offs.push(o));
  a.handleActorMessage('* set text /any/path/external/pilotdb/elements/77/lines/LM-Line_1/state/current O');
  assert.deepStrictEqual(offs, [{ elementId: '77' }]);
});

test('--source selects adapters: director only | trio only | auto = both', () => {
  const director = buildAdapters({ source: 'director' }).map((x) => x.source);
  const trio = buildAdapters({ source: 'trio' }).map((x) => x.source);
  const auto = buildAdapters({ source: 'auto' }).map((x) => x.source);
  assert.deepStrictEqual(director, ['director']);
  assert.deepStrictEqual(trio, ['trio']);
  assert.deepStrictEqual(auto, ['director', 'trio']);
  // unknown -> auto, and the director adapter needs the actor / trio needs stomp
  assert.deepStrictEqual(buildAdapters({ source: 'bogus' }).map((x) => x.source), ['director', 'trio']);
});

// The headline Stage-2b proof: feed a take-in -> out actor sequence to a real
// Recorder (Pilot join stubbed) and assert it PRODUCES a director-sourced
// off-air, then that replay reconstructs a complete (took -> left) Stripe.
test('recorder produces an off-air from the director stream; replay reconstructs took→left', async () => {
  const msgs = JSON.parse(fs.readFileSync(FIX_TAKEOUT_ACTOR, 'utf8'));
  const writer = memWriter();
  let t = 0;
  const now = () => `2026-06-16T19:00:${String(t++).padStart(2, '0')}.000Z`;
  const rec = new Recorder(baseCfg({ source: 'director', pilotHost: '10.0.0.5', exclusiveField: '2' }),
    { writer, logger: () => {}, now });
  // Stub the Pilot join so the take carries Stripe content (home/test has no Pilot).
  const stripeContent = { elementId: '20001', templateId: '16082', templateName: 'Stripe',
    fields: { '0': 'ראש הממשלה נואם', '1': '', '2': '' }, texts: ['ראש הממשלה נואם'] };
  rec._fetchContent = async () => ({ content: stripeContent, pending: false, error: null, raw: '<xml/>' });

  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16082', line2Field: '1', source: 'director' } });
  for (const msg of msgs) {
    rec.adapters.forEach((a) => { if (a.needsActor) a.handleActorMessage(msg); });
    await new Promise((r) => setImmediate(r)); // let the async take's Pilot join settle
  }
  rec._record({ source: 'recorder', type: 'session', event: 'stop', eventCount: writer.count });

  const take = writer.events.find((e) => e.type === 'take');
  assert.ok(take, 'a take must be recorded');
  assert.strictEqual(take.source, 'director');
  assert.strictEqual(take.elementId, '20001');
  assert.strictEqual(take.isStripe, true);
  assert.strictEqual(take.variant, 'ONE_LINE');

  const off = writer.events.find((e) => e.type === 'off-air');
  assert.ok(off, 'the recorder MUST emit an off-air from the director stream');
  assert.strictEqual(off.source, 'director');
  assert.strictEqual(off.elementId, '20001');
  assert.strictEqual(off.isStripe, true);

  // replay the recorder's own output -> one complete Stripe instance.
  const result = reconstruct(writer.events);
  assert.strictEqual(result.stripe.length, 1);
  const inst = result.stripe[0];
  assert.ok(inst.tookAt, 'took');
  assert.ok(inst.leftAt, 'left');
  assert.strictEqual(inst.stillOnAir, false);
});

// The committed recorder-output fixture replays to a complete instance too.
test('committed stripe-takeout.jsonl replays to a complete (took→left) Stripe', () => {
  const result = replayFile(FIX_TAKEOUT);
  assert.strictEqual(result.stripe.length, 1);
  assert.ok(result.stripe[0].leftAt, 'has an off-air / left time');
  assert.strictEqual(result.stripe[0].stillOnAir, false);
  assert.strictEqual(result.sessionStopped, true);
});
