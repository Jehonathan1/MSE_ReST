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
  parseMseElementData,
  parseLastTakenElement,
  parseChannelState,
  resolveBasedOn,
  deriveVariant,
  deriveExclusive,
  contentSignature,
} = require('../src/recorder/parsers');
const { parseJsonl, reconstruct, replayFile, ReplayError } = require('../replay');
const { buildTimeline, sufficiencyReport, emitFile, pickConcurrentStripe } = require('../timeline');
const { Recorder } = require('../src/recorder/recorder');
const { parseDirectorEvent } = require('../src/recorder/offair');
const { parseEngineConsoleLine } = require('../src/recorder/engineConsole');
const { DirectorAdapter, TrioAdapter, EngineConsoleAdapter, buildAdapters } = require('../src/recorder/adapters');

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
const FIX_RESTRIPE_ACTOR = path.join(__dirname, 'fixtures', 'stripe-restripe.actor.json');
const FIX_ONAIR_EDIT_MSE = path.join(__dirname, 'fixtures', 'stripe-onair-edit.mse.json');
const FIX_ENGINE_CLEANUP = path.join(__dirname, 'fixtures', 'engine-cleanup.console.txt');

// Stage 3: the three REAL Stage-2d captures the sufficiency check is grounded in.
// The working captures live in the gitignored recordings/ ("office captures live
// outside git"); these are byte-for-byte mirrors committed under test/fixtures/live
// so the suite is reproducible on a fresh clone.
const LIVE = path.join(__dirname, 'fixtures', 'live');
const CAP_16 = path.join(LIVE, '2026-06-17T09-15-40.203Z.jsonl');           // 16-event end-to-end
const CAP_16_TIMELINE = path.join(LIVE, '2026-06-17T09-15-40.203Z.timeline.json'); // committed artifact
const CAP_TRIO = path.join(LIVE, '2026-06-17T09-27-53.322Z.jsonl');         // 4-event Trio-only
const CAP_DIRECTOR = path.join(LIVE, '2026-06-17T09-04-40.330Z.jsonl');     // 13-event Director

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

// === Fix A (§4.1): same-stripe out→in re-take detected from the line A/O stream ==
//
// Shoot §8.6 proved the line A/O event stream (set text …/LM-Line_N/state/current
// A|O) is RECEIVED and correctly classified as take/out by offair.parseDirectorEvent
// — the directorAdapter just never EMITTED a take from an 'A' (takes came only from
// last_taken_element path changes, which freeze on a same-element re-take to the
// same line). These cases drive the line A/O frames through the recorder's OWN
// parseDirectorEvent (no hand-rolled parser): on HEAD the re-in emits no take; after
// the fix it emits exactly one take for the same element, attributed via lineToElement.

test('Fix A: a same-line re-take (ID-less A) re-emits a take via the line map [adapter]', () => {
  const a = new DirectorAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const takes = []; const offs = [];
  a.on('take', (r) => takes.push(r));
  a.on('off-air', (o) => offs.push(o));

  // first take carries BOTH the element id and its line -> populates lineToElement.
  a.handleActorMessage('* set text /scheduler/s/external/pilotdb/elements/20001/lines/LM-Line_1/state/current A');
  assert.strictEqual(takes.length, 1, 'the first line-A emits a take');
  assert.strictEqual(takes[0].elementId, '20001');

  // out on the same line (element=? — ID-less, as the live re-take frames are).
  a.handleActorMessage('* set text /scheduler/s/show/lines/LM-Line_1/state/current O');
  assert.deepStrictEqual(offs, [{ elementId: '20001' }]);

  // re-take to the SAME line, still ID-less: resolves to 20001 via lineToElement,
  // which must survive the out — last_taken is frozen so this is the only signal.
  a.handleActorMessage('* set text /scheduler/s/show/lines/LM-Line_1/state/current A');
  assert.strictEqual(takes.length, 2, 'the same-line re-take re-emits a take (was the §4.1 blind spot)');
  assert.strictEqual(takes[1].elementId, '20001');
});

test('Fix A: same-stripe out→in fixture → second take recorded; replay took→left + re-take', async () => {
  const events = await runDirectorFixture(FIX_RESTRIPE_ACTOR);
  const takes = events.filter((e) => e.type === 'take');
  // HEAD records ONLY the first take (the re-in is invisible: no last_taken delta,
  // no take emitted from the line-A). The fix records the re-in as a 2nd take.
  assert.strictEqual(takes.length, 2, 'the same-stripe re-take is detected as a second take');
  assert.ok(takes.every((t) => t.elementId === '20001'), 'both takes are element 20001');
  assert.ok(takes.every((t) => t.source === 'director' && t.isStripe), 'director Stripe takes');

  const offs = events.filter((e) => e.type === 'off-air');
  assert.strictEqual(offs.length, 1, 'exactly one off-air between the two takes (the out)');
  assert.strictEqual(offs[0].elementId, '20001');

  // replay: first instance complete (took→left); the re-take is still on air at the
  // clean session stop.
  const r = reconstruct(events).stripe;
  assert.strictEqual(r.length, 2, 'two Stripe instances of the same element');
  assert.ok(r[0].tookAt && r[0].leftAt && !r[0].stillOnAir, 'first instance took→left');
  assert.ok(r[1].tookAt && r[1].stillOnAir, 'second (re-take) instance still on air at stop');
});

test('Fix A regression: a distinct-element take fires once when BOTH last_taken and line-A arrive', async () => {
  const writer = memWriter();
  const rec = new Recorder(baseCfg({ source: 'director', pilotHost: '10.0.0.5', stripeTemplateId: '16082' }),
    { writer, logger: () => {}, now: () => 't' });
  rec._fetchContent = async (id) => ({
    content: { elementId: id, templateId: '16082', templateName: 'S', fields: { '0': 'a', '1': '' }, texts: ['a'] },
    pending: false, error: null, raw: '<x/>',
  });
  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16082', line2Field: '1', source: 'director' } });
  const d = rec.adapters.find((a) => a.source === 'director');

  // Both signals for the SAME fresh element: the line-A (with id) AND the last_taken
  // delta. The core's on-air map must de-dupe to exactly one take.
  d.handleActorMessage('* set text /scheduler/s/external/pilotdb/elements/30001/lines/LM-Line_1/state/current A');
  await new Promise((r) => setImmediate(r));
  d.handleActorMessage('* set text /state/last_taken_element {1}<entry name="path">/external/pilotdb/elements/30001</entry>');
  await new Promise((r) => setImmediate(r));

  const takes = writer.events.filter((e) => e.type === 'take');
  assert.strictEqual(takes.length, 1, 'no double-emit: distinct-element take fires exactly once');
  assert.strictEqual(takes[0].elementId, '30001');
});

// === Fix B (§8.3): on-air edit sourced from the MSE element data subnodes =====
//
// An on-air text edit updates the LIVE MSE document, not the saved Pilot DB
// element (proven byte-identical + same etag, shoot §8.3). The content-poll only
// re-read Pilot, so it never saw the edit. The edited values live on the element
// node's <entry name="data"> subnodes (shoot §8.5 / API §"Live Update Support");
// the fix sources on-air content from there via PepTalk and emits a `change` when
// that signature moves.

test('parseMseElementData parses <entry name="data"> leaves into 0-indexed content (skips decoys)', () => {
  const fix = JSON.parse(fs.readFileSync(FIX_ONAIR_EDIT_MSE, 'utf8'));
  const before = parseMseElementData(fix.before, '2380782');
  assert.strictEqual(before.elementId, '2380782');
  assert.strictEqual(before.templateId, '16097');
  // 4-layer MSE data is 1-indexed -> normalized to the recorder's 0-indexed fields;
  // the <entry name="data"> isolation drops the schema decoy (name="5").
  assert.deepStrictEqual(before.fields, { '0': 'דרעי מצטרף לקריאה לפיזור הכנסת', '1': 'יו"ר ש"ס מצטרף' });
  assert.deepStrictEqual(before.texts, ['דרעי מצטרף לקריאה לפיזור הכנסת', 'יו"ר ש"ס מצטרף']);
  assert.strictEqual(deriveVariant(before, '1'), 'TWO_LINE'); // Line_2 (field '1') populated

  const after = parseMseElementData(fix.after, '2380782');
  assert.strictEqual(after.fields['0'], 'ועכשיו כתוב פה משהו אחר לגמרי!');
  assert.notStrictEqual(contentSignature(before), contentSignature(after), 'an on-air edit moves the signature');
});

test('Fix B: on-air edit (MSE data changed, Pilot unchanged) emits exactly one mse change', async () => {
  const writer = memWriter();
  const rec = new Recorder(baseCfg({ source: 'director', pilotHost: '10.0.0.5', stripeTemplateId: '16097', line2Field: '1' }),
    { writer, logger: () => {}, now: () => 't' });
  // Pilot stays byte-identical the whole test — the saved DB element an on-air edit
  // never touches (shoot §8.3).
  const pilot = { elementId: '20001', templateId: '16097', templateName: 'S',
    fields: { '0': 'orig line 1', '1': 'orig line 2' }, texts: ['orig line 1', 'orig line 2'] };
  rec._fetchContent = async () => ({ content: pilot, pending: false, error: null, raw: '<x/>' });
  // MSE live content starts equal to Pilot, then the operator edits Line_1 on air.
  let mse = { elementId: '20001', templateId: '16097', templateName: 'MSE Element',
    fields: { '0': 'orig line 1', '1': 'orig line 2' }, texts: ['orig line 1', 'orig line 2'] };
  rec._fetchMseElementData = async () => ({ content: mse });

  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16097', line2Field: '1', source: 'director' } });
  await rec._onTakeSignal({ elementId: '20001', templateId: '16097' }, 'director');
  assert.strictEqual(writer.events.filter((e) => e.type === 'take').length, 1, 'one take recorded');

  // poll #1 — establishes the live MSE baseline; no change.
  await rec._refreshOnAirContent();
  assert.strictEqual(writer.events.filter((e) => e.type === 'change').length, 0, 'baseline read emits no change');

  // operator edits Line_1 ON AIR — only the MSE document changes; Pilot untouched.
  mse = { elementId: '20001', templateId: '16097', templateName: 'MSE Element',
    fields: { '0': 'EDITED on air', '1': 'orig line 2' }, texts: ['EDITED on air', 'orig line 2'] };
  await rec._refreshOnAirContent();
  const changes = writer.events.filter((e) => e.type === 'change');
  assert.strictEqual(changes.length, 1, 'the on-air edit emits exactly one change');
  assert.strictEqual(changes[0].source, 'mse', 'change is MSE-sourced, not Pilot');
  assert.strictEqual(changes[0].elementId, '20001');
  assert.deepStrictEqual(changes[0].content.texts, ['EDITED on air', 'orig line 2'], 'change carries the edited line');

  // poll again with identical MSE content — no spurious change (signature match).
  await rec._refreshOnAirContent();
  assert.strictEqual(writer.events.filter((e) => e.type === 'change').length, 1, 'no spurious change when MSE content is identical');
});

test('Fix B: a missing/transient live MSE node is tolerated (no change, no throw)', async () => {
  const writer = memWriter();
  const rec = new Recorder(baseCfg({ source: 'director', pilotHost: '10.0.0.5', stripeTemplateId: '16097', line2Field: '1' }),
    { writer, logger: () => {}, now: () => 't' });
  const pilot = { elementId: '20001', templateId: '16097', templateName: 'S',
    fields: { '0': 'a', '1': 'b' }, texts: ['a', 'b'] };
  rec._fetchContent = async () => ({ content: pilot, pending: false, error: null, raw: '<x/>' });
  rec._fetchMseElementData = async () => ({ content: null }); // /data/VCP/... transient/absent
  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16097', line2Field: '1', source: 'director' } });
  await rec._onTakeSignal({ elementId: '20001', templateId: '16097' }, 'director');
  await rec._refreshOnAirContent();
  await rec._refreshOnAirContent();
  assert.strictEqual(writer.events.filter((e) => e.type === 'change').length, 0, 'absent live node => no change');
});

test('DirectorAdapter.getNode issues a read-only get and resolves its payload (null on inexistent)', async () => {
  const sent = [];
  const a = new DirectorAdapter({ cfg: {}, now: () => 't', log: () => {} });
  a.attachActor((frame) => sent.push(frame));
  const p = a.getNode('/external/pilotdb/elements/20001');
  const getFrame = sent.find((f) => /\bget \/external\/pilotdb\/elements\/20001\b/.test(f));
  assert.ok(getFrame, 'getNode issues a read-only `get`');
  const id = getFrame.match(/^(\d+)\s/)[1];
  a.handleActorMessage(`${id} ok {12}<element/>`);
  assert.ok(/<element\/>/.test(await p), 'resolves the get payload');

  const p2 = a.getNode('/data/VCP/none');
  const id2 = sent[sent.length - 1].match(/^(\d+)\s/)[1];
  a.handleActorMessage(`${id2} error inexistent /data/VCP/none`);
  assert.strictEqual(await p2, null, 'an inexistent node resolves null (tolerated)');
  a.stop();
});

// === Stage 3: timeline emitter + sufficiency check (grounded in REAL captures) ==
//
// The Stage-2d captures must contain everything the Stage-4 bridge needs. These
// tests assert the normalized bridge contract reconstructs the real captures
// correctly and that the canonical 16-event capture is SUFFICIENT.

// pickConcurrentStripe: the gate's owner is the most-recently-taken Stripe still
// on air at the gate's take time (single-owner even when two are "open").
test('pickConcurrentStripe picks the most-recently-taken on-air Stripe', () => {
  const stripes = [
    { elementId: 'A', tookAt: 't1', leftAt: 't9', stillOnAir: false },
    { elementId: 'B', tookAt: 't3', leftAt: null, stillOnAir: true },
    { elementId: 'C', tookAt: 't7', leftAt: 't8', stillOnAir: false }, // not yet on air at t5
  ];
  assert.strictEqual(pickConcurrentStripe(stripes, 't5').elementId, 'B'); // A & B on air, B newer
  assert.strictEqual(pickConcurrentStripe(stripes, 't2').elementId, 'A'); // only A on air
  assert.strictEqual(pickConcurrentStripe([], 't5'), null);              // no stripe → orphan gate
});

// --- the canonical 16-event capture: 5 TWO_LINE Stripes + one gate window -----
test('timeline: 16-event capture → 5 TWO_LINE Stripes, one exclusive gate, clean close', () => {
  const tl = buildTimeline(parseJsonl(fs.readFileSync(CAP_16, 'utf8')));
  assert.strictEqual(tl.capture.sessionStopped, true, 'session closed cleanly');
  assert.strictEqual(tl.stripeCount, 5);
  assert.ok(tl.stripes.every((s) => s.variant === 'TWO_LINE'), 'all 5 Stripes TWO_LINE');
  assert.ok(tl.stripes.every((s) => s.states.every((st) => st.texts && st.variant)), 'real content, no pending');

  // exactly one gate window, from the co-airing 16092 element, on stripe 2369176.
  assert.strictEqual(tl.gateWindows.length, 1);
  const g = tl.gateWindows[0];
  assert.strictEqual(g.elementId, '2378195');
  assert.strictEqual(g.templateId, '16092');
  assert.strictEqual(g.concurrentStripe, '2369176');

  // 16092 is kept OUT of the Stripe instance list.
  assert.ok(!tl.stripes.some((s) => s.elementId === '2378195'), '16092 not a Stripe instance');

  // the gate folds into 2369176's exclusiveGate as an ON→OFF window.
  const owner = tl.stripes.find((s) => s.elementId === '2369176');
  assert.deepStrictEqual(owner.exclusiveGate, [
    { at: '2026-06-17T09:17:22.738Z', on: true },
    { at: '2026-06-17T09:17:37.314Z', on: false },
  ]);
  // and the gate did NOT off-air its Stripe — 2369176 left AFTER the gate closed.
  assert.ok(owner.leftAt > g.off, 'exclusive co-exists: stripe off-airs after the gate, not because of it');

  // the last take (2369200) is still on air at the clean stop.
  const last = tl.stripes[tl.stripes.length - 1];
  assert.strictEqual(last.elementId, '2369200');
  assert.strictEqual(last.stillOnAir, true);
  assert.strictEqual(last.leftAt, null);
});

// The single-occupancy handover (seq 11 off-air precedes seq 12 take), proving
// 2369176 emits its OWN OUT — distinct from the exclusive co-airing of seq 9.
test('timeline: 2369176 off-air (seq 11) precedes the 2377827 take (seq 12), gate is separate', () => {
  const events = parseJsonl(fs.readFileSync(CAP_16, 'utf8'));
  const off176 = events.find((e) => e.type === 'off-air' && e.elementId === '2369176');
  const take827b = events.filter((e) => e.type === 'take' && e.elementId === '2377827')[1]; // 2nd instance
  assert.ok(off176 && take827b);
  assert.ok(off176.seq < take827b.seq, 'single-occupancy off-air precedes the next take');
  assert.ok(off176.ts <= take827b.ts, 'and is not later in time');
  // the exclusive (seq 9) did NOT off-air 2369176 — its OUT (seq 11) comes later.
  const take195 = events.find((e) => e.type === 'take' && e.elementId === '2378195');
  assert.ok(take195.seq < off176.seq, 'exclusive take precedes the stripe OUT — it did not cause it');
});

// --- Trio-only capture: zero instances, clean close, NO throw -----------------
test('timeline: Trio-only 4-event capture → zero Stripe instances, clean close, no throw', () => {
  const tl = buildTimeline(parseJsonl(fs.readFileSync(CAP_TRIO, 'utf8')));
  assert.strictEqual(tl.stripeCount, 0);
  assert.deepStrictEqual(tl.stripes, []);
  assert.deepStrictEqual(tl.gateWindows, []);
  assert.strictEqual(tl.capture.sessionStopped, true);
  // and the sufficiency check treats zero-instance-clean-close as a PASS, not a failure.
  const rep = sufficiencyReport(parseJsonl(fs.readFileSync(CAP_TRIO, 'utf8')));
  assert.strictEqual(rep.pass, true);
});

// --- Director 13-event capture: its instances + the gate on the visible stripe -
test('timeline: Director 13-event capture → 4 TWO_LINE Stripes, gate on the visible stripe', () => {
  const tl = buildTimeline(parseJsonl(fs.readFileSync(CAP_DIRECTOR, 'utf8')));
  assert.strictEqual(tl.stripeCount, 4);
  assert.ok(tl.stripes.every((s) => s.variant === 'TWO_LINE'));
  // 16092 co-aired while two stripes were "open"; the gate attaches to the
  // most-recently-taken (visible) one, 2377768 — single owner.
  assert.strictEqual(tl.gateWindows.length, 1);
  assert.strictEqual(tl.gateWindows[0].concurrentStripe, '2377768');
  const owner = tl.stripes.find((s) => s.elementId === '2377768');
  assert.strictEqual(owner.exclusiveGate.length, 2);
  assert.strictEqual(owner.exclusiveGate[0].on, true);
  assert.strictEqual(owner.exclusiveGate[1].on, false);
});

// --- sufficiency verdict + the declared non-blocking gaps ---------------------
test('sufficiency: the 16-event capture is SUFFICIENT, with declared non-blocking gaps', () => {
  const rep = sufficiencyReport(parseJsonl(fs.readFileSync(CAP_16, 'utf8')));
  assert.strictEqual(rep.pass, true);
  assert.ok(rep.checks.every((c) => c.ok), 'every blocking check passes');
  assert.strictEqual(rep.stripeCount, 5);
  // the two known non-blocking gaps are surfaced, not papered over.
  const fields = rep.missingFields.map((m) => m.field);
  assert.ok(fields.some((f) => /exclusiveField/.test(f)), 'exclusive-field gap surfaced');
  assert.ok(fields.some((f) => /ONE_LINE/.test(f)), 'ONE_LINE-from-live gap surfaced');
  assert.ok(rep.missingFields.every((m) => m.blocking === false), 'all gaps are non-blocking');
});

// --- the committed reconstructed-timeline artifact is stable ------------------
test('the committed 16-event timeline.json equals a fresh re-emit (stable artifact)', () => {
  const committed = JSON.parse(fs.readFileSync(CAP_16_TIMELINE, 'utf8'));
  const fresh = emitFile(CAP_16, { sourceLabel: '2026-06-17T09-15-40.203Z.jsonl' });
  assert.deepStrictEqual(fresh, committed, 'regenerating the emitter must reproduce the committed artifact');
});

// === Issue 4: profile/engine CLEANUP detection (engine console 6100) ==========
//
// A profile cleanup (`POST /profiles/<p>/cleanup`) is INVISIBLE on the MSE actor
// stream — it fires at the engine as the all-layer `RENDERER*<LAYER> SET_OBJECT`
// unload + `… CLEANUP` block (on-site 2026-06-25, ids 552–560). last_taken stays
// frozen, no per-line off-air, the `/Cleaning up viz-handlers/` log line is not
// emitted, so the recorder logged 0 lines and downstream mirrors stuck on the last
// stripe. These tests prove the engine-console classifier + the recorder's clear
// fan-out, reproduce-first (the live socket/file glue is confirmed on-site).

// --- the pure per-line classifier --------------------------------------------
test('parseEngineConsoleLine: empty SET_OBJECT = clear; with a scene = load; CLEANUP verbs; noise rejected', () => {
  // an empty `RENDERER*<LAYER> SET_OBJECT` = a layer UNLOAD (clear)
  assert.deepStrictEqual(parseEngineConsoleLine('RENDERER*MAIN_LAYER SET_OBJECT'),
    { kind: 'clear', layer: 'MAIN_LAYER' });
  assert.deepStrictEqual(parseEngineConsoleLine('RENDERER*FRONT_LAYER SET_OBJECT   '),
    { kind: 'clear', layer: 'FRONT_LAYER' });
  // a SET_OBJECT WITH a scene = a LOAD (take), never a clear
  assert.deepStrictEqual(parseEngineConsoleLine('RENDERER*MAIN_LAYER SET_OBJECT SCENE*i24/stripe'),
    { kind: 'load', layer: 'MAIN_LAYER', object: 'SCENE*i24/stripe' });
  // the cleanup-block verbs
  assert.strictEqual(parseEngineConsoleLine('SCENE CLEANUP').kind, 'cleanup');
  assert.strictEqual(parseEngineConsoleLine('MAPS CACHE CLEANUP').kind, 'cleanup');
  assert.strictEqual(parseEngineConsoleLine('MATERIAL CLEANUP').what, 'MATERIAL');
  // the real idle-console noise must classify as null (no false positive)
  assert.strictEqual(parseEngineConsoleLine('failed to process command RENDERER*BACK_LAYER*TREE*#17105*GEOM*TYPE'), null);
  assert.strictEqual(parseEngineConsoleLine('failed to process command RENDERER*MAIN_LAYER SET_OBJECT'), null);
  assert.strictEqual(parseEngineConsoleLine('TM: Texture 60 none (size: 71k) on pipe 0 removed.'), null);
  assert.strictEqual(parseEngineConsoleLine('LEAVING SESSION (default): 000001F'), null);
  assert.strictEqual(parseEngineConsoleLine(''), null);
});

// --- the adapter latch: one clear per cleanup block; take-out does NOT fire ----
test('EngineConsoleAdapter: the cleanup block fires exactly one clear', () => {
  const a = new EngineConsoleAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const clears = [];
  a.on('clear', (info) => clears.push(info));
  a.ingestConsoleLines(fs.readFileSync(FIX_ENGINE_CLEANUP, 'utf8'));
  assert.strictEqual(clears.length, 1, 'the whole cleanup block emits a single clear');
  assert.match(clears[0].reason, /cleanup|unload/);
});

test('EngineConsoleAdapter: a normal take-out (single-layer clear, no CLEANUP block) does NOT fire', () => {
  const a = new EngineConsoleAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const clears = [];
  a.on('clear', (info) => clears.push(info));
  // a take loads a scene; a per-element take-out empties ONE layer and runs NO
  // cleanup block — neither is a profile cleanup.
  a.ingestConsoleLines([
    'RENDERER*MAIN_LAYER SET_OBJECT SCENE*i24/stripe', // take (load)
    'RENDERER*MAIN_LAYER SET_OBJECT',                  // take-out: one layer cleared
  ].join('\n') + '\n');
  assert.strictEqual(clears.length, 0, 'a single-layer clear with no CLEANUP block is not a profile cleanup');
});

test('EngineConsoleAdapter: re-arms after a take so a second cleanup fires again', () => {
  const a = new EngineConsoleAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const clears = [];
  a.on('clear', (info) => clears.push(info));
  a.ingestConsoleLines('SCENE CLEANUP\n');                       // cleanup #1
  a.ingestConsoleLines('RENDERER*MAIN_LAYER SET_OBJECT SCENE*x\n'); // a take re-arms
  a.ingestConsoleLines('SCENE CLEANUP\n');                       // cleanup #2
  assert.strictEqual(clears.length, 2, 'each cleanup after an intervening take fires once');
});

test('EngineConsoleAdapter: a partial line split across ingest chunks is reassembled', () => {
  const a = new EngineConsoleAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const clears = [];
  a.on('clear', (info) => clears.push(info));
  a.ingestConsoleLines('SCENE CLEA');   // arrives split mid-line
  a.ingestConsoleLines('NUP\n');        // completes it
  assert.strictEqual(clears.length, 1, 'the reassembled cleanup line fires');
});

// --- buildAdapters: engine console is OPT-IN (default recorder unchanged) ------
test('buildAdapters: the engine-console clear detector is opt-in via --engine-console', () => {
  assert.ok(!buildAdapters({ source: 'director' }).some((a) => a.source === 'engine'),
    'default: no engine adapter (no regression to the standard recorder)');
  const withEngine = buildAdapters({ source: 'director', engineConsole: true });
  assert.deepStrictEqual(withEngine.map((a) => a.source), ['director', 'engine']);
  assert.ok(withEngine.find((a) => a.source === 'engine').needsEngine, 'engine adapter self-owns its socket');
});

// --- the headline proof: take a stripe -> engine cleanup -> recorder clears ----
test('Recorder: an engine cleanup off-airs the on-air stripe; replay reconstructs took→left', async () => {
  const writer = memWriter();
  let t = 0;
  const now = () => `2026-06-25T19:00:${String(t++).padStart(2, '0')}.000Z`;
  const rec = new Recorder(baseCfg({ source: 'director', engineConsole: true, pilotHost: '10.0.0.5', stripeTemplateId: '16097', line2Field: '1' }),
    { writer, logger: () => {}, now });
  rec._fetchContent = async (id) => ({
    content: { elementId: id, templateId: '16097', templateName: 'S', fields: { '0': 'a', '1': 'b' }, texts: ['a', 'b'] },
    pending: false, error: null, raw: '<x/>',
  });
  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16097', line2Field: '1', source: 'director' } });

  await rec._onTakeSignal({ elementId: '20001', templateId: '16097' }, 'director');
  assert.strictEqual(rec.onAir.has('20001'), true, 'the stripe is on air');
  assert.strictEqual(writer.events.filter((e) => e.type === 'off-air').length, 0, 'no off-air yet');

  // the engine fires the profile cleanup; feed its console block to the adapter.
  const engine = rec.adapters.find((a) => a.source === 'engine');
  assert.ok(engine, 'the engine adapter is wired');
  engine.ingestConsoleLines(fs.readFileSync(FIX_ENGINE_CLEANUP, 'utf8'));

  const offs = writer.events.filter((e) => e.type === 'off-air');
  assert.strictEqual(offs.length, 1, 'the cleanup off-airs the on-air stripe');
  assert.strictEqual(offs[0].source, 'engine');
  assert.strictEqual(offs[0].elementId, '20001');
  assert.strictEqual(rec.onAir.has('20001'), false, 'removed from the on-air map');

  rec._record({ source: 'recorder', type: 'session', event: 'stop', eventCount: writer.count });
  const inst = reconstruct(writer.events).stripe;
  assert.strictEqual(inst.length, 1);
  assert.ok(inst[0].tookAt && inst[0].leftAt && !inst[0].stillOnAir, 'complete took→left after the cleanup');
});

// --- the cleanup fans out over EVERY on-air element (stripe + co-airing exclusive) -
test('Recorder: an engine cleanup off-airs ALL on-air elements (full-program clear)', async () => {
  const writer = memWriter();
  const rec = new Recorder(baseCfg({ source: 'director', engineConsole: true, pilotHost: '10.0.0.5', stripeTemplateId: '16097', line2Field: '1' }),
    { writer, logger: () => {}, now: () => 't' });
  const tpl = { 20001: '16097', 20003: '16092' }; // a stripe + a co-airing exclusive
  rec._fetchContent = async (id) => ({
    content: { elementId: id, templateId: tpl[id], templateName: 'S', fields: { '0': 'a', '1': 'b' }, texts: ['a', 'b'] },
    pending: false, error: null, raw: '<x/>',
  });
  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16097', line2Field: '1', source: 'director' } });
  await rec._onTakeSignal({ elementId: '20001', templateId: '16097' }, 'director'); // stripe
  await rec._onTakeSignal({ elementId: '20003', templateId: '16092' }, 'director'); // exclusive co-airs
  assert.strictEqual(rec.onAir.size, 2, 'both on air before the cleanup');

  rec.adapters.find((a) => a.source === 'engine').ingestConsoleLines('RENDERER*FRONT_LAYER SET_OBJECT\nRENDERER*MAIN_LAYER SET_OBJECT\nSCENE CLEANUP\n');

  const offs = writer.events.filter((e) => e.type === 'off-air').map((e) => e.elementId).sort();
  assert.deepStrictEqual(offs, ['20001', '20003'], 'the cleanup clears the whole program, not just one element');
  assert.strictEqual(rec.onAir.size, 0, 'nothing left on air');
});

// === Defect 1 (night-61b): cleanup does NOT reset the take cursor =============
//
// On-site 2026-06-28: after a profile/engine cleanup, taking an element DIRECTLY
// (no playlist initialize) mirrored the PREVIOUS headline then snapped. Cause:
// the actor's last_taken_element is a take CURSOR, not an on-air flag, and a
// cleanup does NOT reset it — so the next id-less line take resolved to the
// now-off-air element through the adapter's stale attribution maps (lineToElement
// / currentActiveElementId) and the core's stale _lastTakenStripeId, instead of
// re-resolving from the authoritative last_taken read. The fix drops that stale
// bookkeeping on a clear (recorder._onClearSignal -> adapter.handleClear), so the
// next post-cleanup take re-resolves cleanly. Reproduce-first: both cases FAIL on
// 57a4f45 and PASS after EDIT 1+2. The cleanup signal's own fixture is
// engine-cleanup.console.txt; the takes are driven through a real Recorder.

test('Defect 1 (attribution): an id-less DIRECT take after a cleanup attributes to the just-taken element, not the frozen pre-cleanup cursor', async () => {
  const writer = memWriter();
  const rec = new Recorder(baseCfg({ source: 'director', engineConsole: true, pilotHost: '10.0.0.5', stripeTemplateId: '16097', line2Field: '1' }),
    { writer, logger: () => {}, now: () => 't' });
  rec._fetchContent = async (id) => ({
    content: { elementId: id, templateId: '16097', templateName: 'S', fields: { '0': 'a', '1': 'b' }, texts: ['a', 'b'] },
    pending: false, error: null, raw: '<x/>',
  });
  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16097', line2Field: '1', source: 'director' } });

  const d = rec.adapters.find((a) => a.source === 'director');
  const sent = [];
  d.send = (f) => sent.push(f); // give the adapter a send channel (no real socket / poll)

  // X taken DIRECTLY on LM-Line_1 (id-bearing 'A') -> on air; lineToElement[L]=X.
  d.handleActorMessage('* set text /scheduler/s/external/pilotdb/elements/2369176/lines/LM-Line_1/state/current A');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(rec.onAir.has('2369176'), true, 'X is on air');

  // a profile cleanup fires at the engine -> the recorder fans out an off-air for X.
  rec.adapters.find((a) => a.source === 'engine').ingestConsoleLines(fs.readFileSync(FIX_ENGINE_CLEANUP, 'utf8'));
  assert.strictEqual(rec.onAir.has('2369176'), false, 'the cleanup off-aired X');

  // operator takes Y DIRECTLY (no initialize): id-less 'A' on the SAME line. The
  // authoritative source is /state/last_taken_element, which the cleanup left
  // pointing past X and a direct take advances to Y.
  sent.length = 0;
  d.handleActorMessage('* set text /scheduler/s/show/lines/LM-Line_1/state/current A');
  const getFrame = [...sent].reverse().find((f) => /get \/state\/last_taken_element/.test(f));
  if (getFrame) {
    const id = getFrame.match(/^(\d+)\s/)[1];
    d.handleActorMessage(`${id} ok {1}<entry name="path">/external/pilotdb/elements/2369200</entry>`);
  }
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const postTakes = writer.events.filter((e) => e.type === 'take').slice(1); // after X's first take
  assert.ok(postTakes.length >= 1, 'the post-cleanup direct take is recorded');
  assert.strictEqual(postTakes[postTakes.length - 1].elementId, '2369200', 'attributes to the just-taken Y');
  assert.ok(!postTakes.some((e) => e.elementId === '2369176'),
    'never re-attributes the post-cleanup take to the now-off-air X (the frozen take cursor)');
});

test('Defect 1 (guard): a cleanup then a re-take of the SAME stripe does NOT fold the lagging working copy at take-time', async () => {
  const writer = memWriter();
  const rec = new Recorder(baseCfg({ source: 'director', engineConsole: true, pilotHost: '10.0.0.5', stripeTemplateId: '16097', line2Field: '1' }),
    { writer, logger: () => {}, now: () => 't' });
  // Pilot serves the FRESH headline for the post-cleanup take.
  rec._fetchContent = async (id) => ({
    content: { elementId: id, templateId: '16097', templateName: 'S', fields: { '0': 'FRESH headline', '1': '' }, texts: ['FRESH headline'] },
    pending: false, error: null, raw: '<x/>',
  });
  // The live MSE working copy LAGS ~1.4s after a cleanup->take: it still holds the
  // PREVIOUS (stale) headline. Folding it at take-time would serve stale content.
  let mseReads = 0;
  rec._fetchMseElementData = async () => {
    mseReads++;
    return { content: { elementId: '2369176', templateId: '16097', templateName: 'MSE Element', fields: { '0': 'STALE previous headline', '1': '' }, texts: ['STALE previous headline'] } };
  };
  rec._record({ source: 'recorder', type: 'session', schemaVersion: 1, event: 'start',
    config: { stripeTemplateId: '16097', line2Field: '1', source: 'director' } });

  // X taken, then a cleanup off-airs it.
  await rec._onTakeSignal({ elementId: '2369176', templateId: '16097' }, 'director');
  rec.adapters.find((a) => a.source === 'engine').ingestConsoleLines(fs.readFileSync(FIX_ENGINE_CLEANUP, 'utf8'));
  assert.strictEqual(rec.onAir.has('2369176'), false, 'the cleanup off-aired the stripe');

  // X is taken AGAIN directly after the cleanup (the on-site repro).
  await rec._onTakeSignal({ elementId: '2369176', templateId: '16097' }, 'director');

  assert.strictEqual(mseReads, 0, 'the lagging working copy is NOT read at take-time after a cleanup');
  assert.strictEqual(writer.events.filter((e) => e.type === 'change').length, 0, 'no take-time change from the stale working copy');
  const lastTake = writer.events.filter((e) => e.type === 'take').pop();
  assert.deepStrictEqual(lastTake.content.texts, ['FRESH headline'], 'the take carries the FRESH Pilot content, not the stale mirror');
});

// === Defect 2 mirror (night-61b): variant from normalized texts[] ============
//
// deriveVariant must derive 1-line/2-line from the normalized texts[] (a verbatim
// mirror of the viz-to-gsap live-mapper), NOT from a padded field key. On HEAD,
// 1-based Pilot content ("01"=Line_1 non-empty, "02"=Line_2 empty) with line2Field
// '1' pads to "01" and reads LINE_1 -> a false TWO_LINE. texts[] (which never
// holds empty strings) is the correct signal.
test('Defect 2 mirror: deriveVariant derives from normalized texts[], not the padded field key', () => {
  // 1-based Pilot content: "01" = Line_1 (non-empty), "02" = Line_2 (empty).
  const oneLine = { fields: { '01': 'only headline', '02': '' }, texts: ['only headline'] };
  assert.strictEqual(deriveVariant(oneLine, '1'), 'ONE_LINE',
    '1-based content with an empty Line_2 is ONE_LINE (was a false TWO_LINE on HEAD)');
  // texts of length 1 -> ONE_LINE; length 2 (both non-empty) -> TWO_LINE.
  assert.strictEqual(deriveVariant({ texts: ['a'] }, '1'), 'ONE_LINE');
  assert.strictEqual(deriveVariant({ texts: ['a', 'b'] }, '1'), 'TWO_LINE');
});
