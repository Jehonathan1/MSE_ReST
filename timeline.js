#!/usr/bin/env node
// timeline.js — the Stage-4 bridge contract emitter + sufficiency check.
//
// Stage 3 formalizes replay as the SUFFICIENCY CHECK for the convergence demo:
// it proves a Stage-2d capture contains everything the bridge (Stage 4) needs and
// emits ONE normalized, documented reconstructed-timeline artifact that Stage 4
// consumes — with NO rendering. It builds on replay.js `reconstruct()` (which
// already rebuilds took → content → variant → left and fails loud on truncation).
//
// The contract, per Stripe instance:
//   { elementId, templateId, tookAt, leftAt|stillOnAir, variant,
//     states:[{at, variant, texts, fields}], exclusiveGate:[{at, on}] }
//
// The exclusive gate is derived from the co-airing **template-16092** element, NOT
// from a 16097 field: a take(16092) while a Stripe is on air ⇒ gate ON; its
// off-air ⇒ gate OFF (Stage-2d finding; see PROJECT.md / KB §4b). The 16092
// element is kept OUT of the Stripe instance list (it is a separate element) and
// its on/off is folded into the concurrent Stripe's `exclusiveGate`.
//
// See TIMELINE-SCHEMA.md for the full Stage-4 contract.
//
// Usage:
//   node timeline.js <file.jsonl> [--emit] [--out PATH] [--report]
//                    [--stripe-template ID] [--line2-field N] [--exclusive-field N]

const fs = require('fs');
const { parseJsonl, reconstruct, ReplayError } = require('./replay');

const SCHEMA_VERSION = 1;

// ISO-8601 strings with the same trailing Z compare lexicographically in
// chronological order, so plain string comparison is a valid time order.
const before = (a, b) => a < b;

// The Stripe instance that "owns" a co-airing gate element: on air at the gate's
// take time and the MOST RECENTLY taken of any such (the visible Stripe). In a
// clean Transition-Logic show there is exactly one; the rule stays single-owner
// even in a capture that missed an intermediate OUT (e.g. the Director capture).
function pickConcurrentStripe(stripes, atTs) {
  let best = null;
  for (const s of stripes) {
    const onAir = !before(atTs, s.tookAt) && (s.stillOnAir || (s.leftAt && before(atTs, s.leftAt)));
    if (!onAir) continue;
    if (!best || before(best.tookAt, s.tookAt)) best = s;
  }
  return best;
}

// Collapse an instance's on-air timeline to its distinct content states. The
// take is always the first state; a `change` only adds a state when variant or
// text actually changed (the bridge maps each new state to a Change).
function instanceStates(inst) {
  const states = [];
  for (const t of inst.timeline) {
    if (t.kind === 'off-air') continue;
    const prev = states[states.length - 1];
    const same = prev && prev.variant === t.variant
      && JSON.stringify(prev.texts) === JSON.stringify(t.texts);
    if (!same) states.push({ at: t.at, variant: t.variant, texts: t.texts || null, fields: t.fields || null });
  }
  return states;
}

// Build the normalized Stage-4 bridge contract from recorder events.
function buildTimeline(events, opts = {}) {
  const r = reconstruct(events, opts);

  const stripes = r.stripe;
  // Gate elements = completed NON-Stripe instances that co-air (e.g. template
  // 16092, the exclusive badge). Kept out of the Stripe list; their on/off folds
  // into the concurrent Stripe's exclusiveGate.
  const gateElements = r.all.filter((i) => !i.isStripe);

  const gateByStripe = new Map();
  const gateWindows = [];
  for (const g of gateElements) {
    const owner = pickConcurrentStripe(stripes, g.tookAt);
    const off = g.stillOnAir ? null : g.leftAt;
    gateWindows.push({
      elementId: g.elementId,
      templateId: g.templateId,
      on: g.tookAt,
      off,
      stillOnAir: g.stillOnAir,
      concurrentStripe: owner ? owner.elementId : null,
    });
    if (!owner) continue;
    const arr = gateByStripe.get(owner.elementId) || [];
    arr.push({ at: g.tookAt, on: true });
    if (off) arr.push({ at: off, on: false });
    gateByStripe.set(owner.elementId, arr);
  }

  const stripeContract = stripes.map((inst) => ({
    elementId: inst.elementId,
    templateId: inst.templateId,
    tookAt: inst.tookAt,
    leftAt: inst.leftAt, // null when still on air at clean stop
    stillOnAir: inst.stillOnAir,
    variant: inst.initial ? inst.initial.variant : null,
    states: instanceStates(inst),
    exclusiveGate: (gateByStripe.get(inst.elementId) || [])
      .slice()
      .sort((a, b) => (before(a.at, b.at) ? -1 : before(b.at, a.at) ? 1 : 0)),
  }));

  const header = events.find((e) => e.type === 'session' && e.event === 'start');
  const stop = events.find((e) => e.type === 'session' && e.event === 'stop');

  return {
    schemaVersion: SCHEMA_VERSION,
    source: opts.sourceLabel || null,
    capture: {
      recordedAt: header ? header.ts : null,
      detectionSource: header && header.config ? header.config.source : null,
      sessionStopped: r.sessionStopped,
      eventCount: stop && stop.eventCount != null ? stop.eventCount : null,
    },
    stripeTemplateId: r.stripeTemplateId,
    line2Field: r.line2Field,
    exclusiveField: r.exclusiveField,
    stripeCount: stripeContract.length,
    stripes: stripeContract,
    // Provenance: the co-airing non-Stripe (16092) elements the gates came from.
    gateWindows,
  };
}

// Sufficiency check: does this capture contain everything the bridge needs?
// Returns structured checks + any field the bridge would want but the capture
// lacks. `pass` is true only when every blocking check passes.
function sufficiencyReport(events, opts = {}) {
  const tl = buildTimeline(events, opts);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('session closed cleanly', tl.capture.sessionStopped,
    tl.capture.sessionStopped ? 'session stop present' : 'NO session stop — truncated');

  // Every reconstructed state carries real, resolved content (no contentPending).
  const pendingStates = [];
  for (const s of tl.stripes) {
    for (const st of s.states) {
      if (!st.texts || st.variant == null) pendingStates.push(s.elementId);
    }
  }
  add('real content present (no contentPending)', pendingStates.length === 0,
    pendingStates.length === 0 ? 'all states carry resolved Pilot content'
      : `contentPending on: ${pendingStates.join(', ')}`);

  const variants = tl.stripes.map((s) => s.variant);
  add('all Stripe instances variant-derived', variants.every((v) => v === 'ONE_LINE' || v === 'TWO_LINE'),
    `variants: ${variants.join(', ') || '(none)'}`);

  // Exclusive gate: each gate's concurrent Stripe must NOT be off-aired by the
  // gate take (co-existence), and must map to an ON→OFF window.
  const coexist = tl.gateWindows.every((g) => {
    if (!g.concurrentStripe) return false;
    const owner = tl.stripes.find((s) => s.elementId === g.concurrentStripe);
    // Owner still on air through the gate (left after gate off, or still on air).
    return owner && (owner.stillOnAir || (g.off && before(g.off, owner.leftAt)) || owner.leftAt === null);
  });
  add('exclusive gate co-exists (does not off-air its Stripe)',
    tl.gateWindows.length === 0 ? true : coexist,
    tl.gateWindows.map((g) => `${g.elementId}/${g.templateId} on=${g.on} off=${g.off || '(open)'} → Stripe ${g.concurrentStripe}`).join('; ') || '(no gate)');

  const lastStripe = tl.stripes[tl.stripes.length - 1] || null;

  // Fields the bridge would want but the capture lacks — non-blocking gaps.
  const missing = [];
  if (tl.exclusiveField == null) {
    missing.push({
      field: 'exclusiveField (exclusive "בלעדי" badge Pilot field number)',
      impact: 'per-Stripe `exclusive` stays null; the bridge derives Gate from the co-airing 16092 element instead',
      blocking: false,
    });
  }
  if (!variants.includes('ONE_LINE')) {
    missing.push({
      field: 'a live ONE_LINE Stripe instance',
      impact: 'variant is derived ("is Line_2 empty?") and unit-proven, but no single-line Stripe aired during capture — derive it, do not fake it',
      blocking: false,
    });
  }
  const templateTakes = tl.stripes.filter((s) => s.elementId == null);
  if (templateTakes.length) {
    missing.push({
      field: 'elementId on a template-only take',
      impact: 'a take of an open template (no data element) has elementId:null; not a Stripe data element so non-blocking for the demo',
      blocking: false,
    });
  }

  const blockingFail = checks.some((c) => !c.ok) || missing.some((m) => m.blocking);

  return {
    source: tl.source,
    pass: !blockingFail,
    sessionStopped: tl.capture.sessionStopped,
    stripeCount: tl.stripeCount,
    variants,
    gateWindows: tl.gateWindows,
    lastStripe: lastStripe ? { elementId: lastStripe.elementId, stillOnAir: lastStripe.stillOnAir } : null,
    checks,
    missingFields: missing,
  };
}

function emitFile(filePath, opts = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const events = parseJsonl(text);
  return buildTimeline(events, opts);
}

function reportFile(filePath, opts = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const events = parseJsonl(text);
  return sufficiencyReport(events, opts);
}

function formatReport(rep) {
  const lines = [];
  lines.push(`\n=== Sufficiency report${rep.source ? ` — ${rep.source}` : ''} ===`);
  lines.push(`Stripe instances: ${rep.stripeCount}   variants: ${rep.variants.join(', ') || '(none)'}`);
  lines.push(`Last Stripe: ${rep.lastStripe ? `${rep.lastStripe.elementId} (${rep.lastStripe.stillOnAir ? 'still on air at clean stop' : 'off-air'})` : '(none)'}`);
  for (const c of rep.checks) lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
  if (rep.missingFields.length) {
    lines.push('\n  Fields the bridge would want but the capture lacks:');
    for (const m of rep.missingFields) {
      lines.push(`    ${m.blocking ? '✗ BLOCKING' : '·'} ${m.field}`);
      lines.push(`        → ${m.impact}`);
    }
  } else {
    lines.push('\n  (no missing fields — capture is fully sufficient)');
  }
  lines.push(`\nVERDICT: capture is ${rep.pass ? 'SUFFICIENT ✓' : 'INSUFFICIENT ✗'} for the Stage-4 bridge.`);
  return lines.join('\n');
}

module.exports = {
  buildTimeline,
  sufficiencyReport,
  emitFile,
  reportFile,
  formatReport,
  pickConcurrentStripe,
  SCHEMA_VERSION,
};

// ---- CLI ----
if (require.main === module) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const getFlag = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.split('=')[1] : undefined;
  };
  if (!file) {
    console.error('usage: node timeline.js <file.jsonl> [--emit] [--out PATH] [--report]'
      + ' [--stripe-template ID] [--line2-field N] [--exclusive-field N]');
    process.exit(2);
  }
  const opts = {
    stripeTemplateId: getFlag('stripe-template'),
    line2Field: getFlag('line2-field'),
    exclusiveField: getFlag('exclusive-field'),
    sourceLabel: file.replace(/\\/g, '/').split('/').pop(),
  };
  try {
    if (argv.includes('--report')) {
      console.log(formatReport(reportFile(file, opts)));
    }
    if (argv.includes('--emit') || !argv.includes('--report')) {
      const tl = emitFile(file, opts);
      const json = JSON.stringify(tl, null, 2);
      const out = getFlag('out');
      if (out) {
        fs.writeFileSync(out, json + '\n');
        console.error(`wrote ${out} (${tl.stripeCount} Stripe instances, ${tl.gateWindows.length} gate window(s))`);
      } else {
        console.log(json);
      }
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof ReplayError) {
      console.error(`\n❌ EMIT FAILED: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
