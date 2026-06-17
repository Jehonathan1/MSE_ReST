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
const { DirectorAdapter, TrioAdapter, buildAdapters } = require('../src/recorder/adapters');

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
const FIX_CLEANUP_ACTOR = path.join(__dirname, 'fixtures', 'stripe-cleanup.actor.json');
const FIX_BYLINE_ACTOR = path.join(__dirname, 'fixtures', 'stripe-byline.actor.json');
const FIX_DELETE_ACTOR = path.join(__dirname, 'fixtures', 'stripe-delete.actor.json');
const FIX_CLEANUP = path.join(__dirname, 'fixtures', 'stripe-cleanup.jsonl');
const FIX_BYLINE = path.join(__dirname, 'fixtures', 'stripe-byline.jsonl');
const FIX_DELETE = path.join(__dirname, 'fixtures', 'stripe-delete.jsonl');
const FIX_TRIO = path.join(__dirname, 'fixtures', 'stripe-trio.jsonl');

// A channel-state feed body with the given pilot element ids active.
function channelStateXml(ids) {
  const layers = ids.map((id) => `<state:transition_logic_layer based_on="/external/pilotdb/elements/${id}"/>`).join('');
  return '<?xml version="1.0"?>'
    + '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:state="http://www.vizrt.com/types/state">'
    + '<entry><title>Main</title><content><state:channel>'
    + `<state:layer name="middle" type="transition_logic">${layers}</state:layer>`
    + '</state:channel></content></entry></feed>';
}

// Drive a committed director actor-script fixture through a real Recorder (Pilot
// stubbed to Stripe content) and return the recorded events — the shared body of
// the Stage-2c director OUT proofs.
async function runDirectorFixture(actorFixturePath) {
  const msgs = JSON.parse(fs.readFileSync(actorFixturePath, 'utf8'));
  const writer = memWriter();
  let t = 0;
  const now = () => `2026-06-16T21:00:${String(t++).padStart(2, '0')}.000Z`;
  const rec = new Recorder(baseCfg({ source: 'director', pilotHost: '10.0.0.5', exclusiveField: '2' }),
    { writer, logger: () => {}, now });
  const stripe = { elementId: '20001', templateId: '16082', templateName: 'Stripe',
    fields: { '0': 'ראש הממשלה נואם', '1': '', '2': '' }, texts: ['ראש הממשלה נואם'] };
  rec._fetchContent = async (id) => (String(id) === '20001'
    ? { content: stripe, pending: false, error: null, raw: '<xml/>' }
    : { content: { elementId: String(id), templateId: '99999', templateName: 'Other', fields: {}, texts: [] }, pending: false, error: null, raw: '<o/>' });
  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16082', line2Field: '1', source: 'director' } });
  for (const msg of msgs) {
    rec.adapters.forEach((a) => { if (a.needsActor) a.handleActorMessage(msg); });
    await new Promise((r) => setImmediate(r));
  }
  rec._record({ source: 'recorder', type: 'session', event: 'stop', eventCount: writer.count });
  return writer.events;
}

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

// === Stage 2c: official PepTalk OUT model (delete/replace/set verbs) =========

test('parseDirectorEvent: official `delete` verb on the active state path => out', () => {
  const ev = parseDirectorEvent('* delete /scheduler/viz_program/external/pilotdb/elements/20001/handler/data/lines/LM-Line_1');
  assert.strictEqual(ev.action, 'out');
  assert.strictEqual(ev.verb, 'delete');
  assert.strictEqual(ev.elementId, '20001');
  assert.strictEqual(ev.lineNumber, '1');
  // a delete of an unrelated node must NOT be read as an off-air
  assert.strictEqual(parseDirectorEvent('* delete /scheduler/log_level'), null);
});

test('parseDirectorEvent: official `replace` verb carries the new A/O state', () => {
  const out = parseDirectorEvent('* replace /scheduler/s/external/pilotdb/elements/20001/lines/LM-Line_1/state {40}<entry name="state">O</entry>');
  assert.strictEqual(out.action, 'out');
  assert.strictEqual(out.verb, 'replace');
  assert.strictEqual(out.elementId, '20001');
  const take = parseDirectorEvent('* replace /scheduler/s/external/pilotdb/elements/20001/lines/LM-Line_1/state {40}<entry name="state">A</entry>');
  assert.strictEqual(take.action, 'take');
});

test('parseDirectorEvent: system-log "Cleaning up viz-handlers" => out (KB §4b fallback)', () => {
  const ev = parseDirectorEvent('* set text /state/system/log {72}Cleaning up viz-handlers for show /storage/shows/Brand on profile Brand');
  assert.strictEqual(ev.action, 'out');
  assert.strictEqual(ev.rule, 'system_log_cleanup');
  assert.strictEqual(ev.elementId, null); // no element id / line in the cleanup line
  assert.strictEqual(ev.lineName, null);
});

test('DirectorAdapter begin-framing: events inside our own command window are suppressed', () => {
  const a = new DirectorAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const offs = [];
  a.on('off-air', (o) => offs.push(o));
  a.currentActiveElementId = '20001';
  // Simulate a subscribe whose own begin..ok bracket carries an initial O snapshot.
  a.pending.set(7, 'subscribe');
  a.handleActorMessage('7 begin');
  a.handleActorMessage('* set text /scheduler/s/lines/LM-Line_1/state/current O'); // self-caused
  assert.strictEqual(offs.length, 0, 'self-caused (own-begin) events must not fire off-air');
  a.handleActorMessage('7 ok');
  // After the window closes, an external O is honored.
  a.handleActorMessage('* set text /scheduler/s/lines/LM-Line_1/state/current O');
  assert.strictEqual(offs.length, 1);
  assert.strictEqual(offs[0].elementId, '20001');
});

test('DirectorAdapter line-name cross-reference resolves an ID-less OUT (not the active element)', () => {
  const a = new DirectorAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const offs = [];
  a.on('off-air', (o) => offs.push(o));
  // take 'A' carrying BOTH the element id and its line -> records LM-Line_3 -> 20002
  a.handleActorMessage('* set text /scheduler/s/external/pilotdb/elements/20002/lines/LM-Line_3/state/current A');
  // make the active element someone ELSE, so the fallback would resolve wrong
  a.currentActiveElementId = '99999';
  // an ID-less O on LM-Line_3 must resolve to 20002 by line name, NOT 99999
  a.handleActorMessage('* set text /scheduler/s/show/lines/LM-Line_3/state/current O');
  assert.deepStrictEqual(offs, [{ elementId: '20002' }]);
});

test('DirectorAdapter cleanup OUT attributes to the active element', () => {
  const a = new DirectorAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const offs = [];
  a.on('off-air', (o) => offs.push(o));
  a.handleActorMessage('* set text /state/last_taken_element {1}<entry name="path">/external/pilotdb/elements/20001</entry>');
  a.handleActorMessage('* set text /state/system/log {72}Cleaning up viz-handlers for show /storage/shows/Brand on profile Brand');
  assert.deepStrictEqual(offs, [{ elementId: '20001' }]);
});

// New committed director fixtures: each emits a director-sourced off-air and
// replay reconstructs a complete (took -> left) Stripe instance.
for (const [label, actorFix, outFix] of [
  ['cleanup (system-log)', FIX_CLEANUP_ACTOR, FIX_CLEANUP],
  ['by-line (ID-less O)', FIX_BYLINE_ACTOR, FIX_BYLINE],
  ['delete (official verb)', FIX_DELETE_ACTOR, FIX_DELETE],
]) {
  test(`director OUT via ${label}: recorder emits director off-air; replay took→left`, async () => {
    const events = await runDirectorFixture(actorFix);
    const take = events.find((e) => e.type === 'take');
    const off = events.find((e) => e.type === 'off-air');
    assert.ok(take && take.source === 'director' && take.isStripe, 'a director Stripe take');
    assert.ok(off, `${label} MUST emit an off-air`);
    assert.strictEqual(off.source, 'director');
    assert.strictEqual(off.elementId, '20001');
    assert.strictEqual(off.isStripe, true);
    const inst = reconstruct(events).stripe;
    assert.strictEqual(inst.length, 1);
    assert.ok(inst[0].tookAt && inst[0].leftAt && !inst[0].stillOnAir, 'complete took→left');
  });

  test(`committed ${outFix.split(/[\\/]/).pop()} replays to a complete Stripe`, () => {
    const result = replayFile(outFix);
    assert.strictEqual(result.stripe.length, 1);
    assert.ok(result.stripe[0].leftAt);
    assert.strictEqual(result.stripe[0].stillOnAir, false);
  });
}

// === Stage 2c: Trio adapter hardening =======================================

test('TrioAdapter emits normalized take/off-air tagged source:trio; change is Pilot-sourced', async () => {
  const writer = memWriter();
  let t = 0;
  const now = () => `2026-06-16T22:00:${String(t++).padStart(2, '0')}.000Z`;
  const rec = new Recorder(baseCfg({ source: 'trio', pilotHost: '10.0.0.5', channelStateTimeoutMs: 60000 }),
    { writer, logger: () => {}, now });
  let cur = { content: { templateId: '16082', fields: { '0': 'a', '1': '' }, texts: ['a'] }, pending: false, error: null, raw: '<x/>' };
  rec._fetchContent = async () => cur;
  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16082', line2Field: '1', source: 'trio' } });
  const trio = rec.adapters.find((a) => a.source === 'trio');

  trio.handleChannelState(channelStateXml(['20001']));      // take-in
  await new Promise((r) => setImmediate(r));
  cur = { content: { templateId: '16082', fields: { '0': 'a', '1': 'b' }, texts: ['a', 'b'] }, pending: false, error: null, raw: '<x/>' };
  await rec._refreshOnAirContent();                          // Pilot change while on air
  trio.handleChannelState(channelStateXml([]));              // take-out (set empties)
  rec._record({ source: 'recorder', type: 'session', event: 'stop', eventCount: writer.count });

  const take = writer.events.find((e) => e.type === 'take');
  const change = writer.events.find((e) => e.type === 'change');
  const off = writer.events.find((e) => e.type === 'off-air');
  assert.strictEqual(take.source, 'trio');
  assert.strictEqual(take.variant, 'ONE_LINE');
  assert.strictEqual(change.source, 'pilot');     // content change is Pilot-sourced by architecture
  assert.strictEqual(change.variant, 'TWO_LINE');
  assert.strictEqual(off.source, 'trio');
  assert.strictEqual(off.elementId, '20001');
  // replay reconstructs the full lifecycle
  const inst = reconstruct(writer.events).stripe;
  assert.strictEqual(inst.length, 1);
  assert.ok(inst[0].tookAt && inst[0].leftAt && !inst[0].stillOnAir);
});

test('committed stripe-trio.jsonl replays to a complete (took→change→left) Stripe', () => {
  const result = replayFile(FIX_TRIO);
  assert.strictEqual(result.stripe.length, 1);
  const kinds = result.stripe[0].timeline.map((t) => t.kind);
  assert.deepStrictEqual(kinds, ['take', 'change', 'off-air']); // 1-line take -> 2-line change -> out
  const onAir = result.stripe[0].timeline.filter((t) => t.kind !== 'off-air');
  assert.deepStrictEqual(onAir.map((t) => t.variant), ['ONE_LINE', 'TWO_LINE']);
  assert.strictEqual(result.stripe[0].stillOnAir, false);
});

test('TrioAdapter watchdog warns when no channel-state arrives, stays silent once it does', () => {
  const logs = [];
  const a = new TrioAdapter({ cfg: { channelStateTimeoutMs: 50 }, now: () => 't', log: (m) => logs.push(m) });
  a._warnIfNoChannelState();
  assert.ok(logs.some((l) => /no channel-state/i.test(l)), 'warns when nothing has arrived');
  logs.length = 0;
  a.handleChannelState(channelStateXml(['20001'])); // a channel-state arrives -> flag set
  a._warnIfNoChannelState();
  assert.ok(!logs.some((l) => /no channel-state/i.test(l)), 'silent once channel-state has been seen');
});

// === Stage 2c: --source auto cross-adapter de-dupe ==========================

test('--source auto records a take/out seen by BOTH director and trio exactly once', async () => {
  const writer = memWriter();
  let t = 0;
  const now = () => `2026-06-16T23:00:${String(t++).padStart(2, '0')}.000Z`;
  const rec = new Recorder(baseCfg({ source: 'auto', pilotHost: '10.0.0.5', channelStateTimeoutMs: 60000 }),
    { writer, logger: () => {}, now });
  rec._fetchContent = async () => ({ content: { templateId: '16082', fields: { '0': 'a', '1': '' }, texts: ['a'] }, pending: false, error: null, raw: '<x/>' });
  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16082', line2Field: '1', source: 'auto' } });
  const director = rec.adapters.find((a) => a.source === 'director');
  const trio = rec.adapters.find((a) => a.source === 'trio');

  // Both legs report the SAME element taking on air.
  director.handleActorMessage('* set text /scheduler/s/external/pilotdb/elements/20001/lines/LM-Line_1/state/current A');
  director.handleActorMessage('* set text /state/last_taken_element {1}<entry name="path">/external/pilotdb/elements/20001</entry>');
  trio.handleChannelState(channelStateXml(['20001']));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(writer.events.filter((e) => e.type === 'take').length, 1, 'one take, not two');

  // Both legs report it going off air.
  director.handleActorMessage('* set text /scheduler/s/external/pilotdb/elements/20001/lines/LM-Line_1/state/current O');
  trio.handleChannelState(channelStateXml([]));
  assert.strictEqual(writer.events.filter((e) => e.type === 'off-air').length, 1, 'one off-air, not two');
});

// === Stage 2d: live-capture regressions (work MSE round 3) ===================

// A second Stripe taking the scheduler line the previous one still holds IS the
// previous element's off-air — it never emits its own OUT (observed live: 2377832
// replaced 2377768 on LM-Line_1 with no OUT for 2377768). At this site takes come
// from the last_taken poll, decoupled from the director 'A' stream, so the core
// derives the replacement deterministically via single-occupancy. An exclusive
// (separate template) co-exists with a stripe and must NOT trigger it.
test('Recorder: a new Stripe take off-airs the previous on-air Stripe (single-occupancy)', async () => {
  const writer = memWriter();
  const rec = new Recorder(baseCfg({ source: 'director', pilotHost: '10.0.0.5', stripeTemplateId: '16097', line2Field: '1' }),
    { writer, logger: () => {}, now: () => 't' });
  const tpl = { 20001: '16097', 20002: '16097', 20003: '16092' };
  rec._fetchContent = async (id) => ({
    content: { elementId: id, templateId: tpl[id], templateName: 'S', fields: { '0': 'a', '1': 'b' }, texts: ['a', 'b'] },
    pending: false, error: null, raw: '<x/>',
  });

  await rec._onTakeSignal({ elementId: '20001', templateId: '16097' }, 'director');
  assert.strictEqual(writer.events.filter((e) => e.type === 'off-air').length, 0, 'first stripe off-airs nobody');

  await rec._onTakeSignal({ elementId: '20002', templateId: '16097' }, 'director');
  const offs = writer.events.filter((e) => e.type === 'off-air');
  assert.strictEqual(offs.length, 1, 'the previous stripe is off-aired');
  assert.strictEqual(offs[0].elementId, '20001');
  assert.strictEqual(rec.onAir.has('20001'), false, 'A removed from on-air');
  assert.strictEqual(rec.onAir.has('20002'), true, 'B is on air');

  // an exclusive (separate template) co-exists — does NOT off-air the stripe
  await rec._onTakeSignal({ elementId: '20003', templateId: '16092' }, 'director');
  assert.strictEqual(writer.events.filter((e) => e.type === 'off-air').length, 1, 'exclusive does not off-air the stripe');
  assert.strictEqual(rec.onAir.has('20002'), true, 'B stays on air alongside the exclusive');
});

// The content-poll must not race a take's in-flight Pilot fetch and emit a
// `change` before the `take` (observed live: a change for 2377832 preceded its
// take). The `taken` guard makes the poll skip a not-yet-recorded element.
test('content-poll emits no change before the take is recorded (race guard)', async () => {
  const writer = memWriter();
  const rec = new Recorder(baseCfg({ source: 'director', pilotHost: '10.0.0.5', stripeTemplateId: '16097', line2Field: '1' }),
    { writer, logger: () => {}, now: () => 't' });
  let release;
  const gate = new Promise((r) => { release = r; });
  const content = { elementId: '20001', templateId: '16097', templateName: 'S', fields: { '0': 'a', '1': 'b' }, texts: ['a', 'b'] };
  rec._fetchContent = async () => { await gate; return { content, pending: false, error: null, raw: '<x/>' }; };

  const takeP = rec._onTakeSignal({ elementId: '20001', templateId: '16097' }, 'director');
  // The take's Pilot fetch is in flight; the slot is reserved but not yet recorded.
  await rec._refreshOnAirContent();
  assert.strictEqual(writer.events.filter((e) => e.type === 'change').length, 0, 'no change before the take is recorded');
  release();
  await takeP;
  assert.strictEqual(writer.events.filter((e) => e.type === 'take').length, 1, 'the take is recorded exactly once');
  assert.strictEqual(writer.events.filter((e) => e.type === 'change').length, 0, 'and still no spurious change');
});
