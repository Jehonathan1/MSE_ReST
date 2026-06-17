#!/usr/bin/env node
// replay.js — offline replay + validation harness for recorder JSONL.
//
// Reads a recording, reconstructs the Stripe on-air timeline (for each Stripe
// instance: when it took, its content, its variant — 1-line vs 2-line derived
// from "is Line_2 empty?" — and when it left), prints it, and validates the
// file is complete. Fails LOUDLY (throws / exit 1) on a truncated recording.
//
// Usage:
//   node replay.js <file.jsonl> [--stripe-template ID] [--line2-field 1] [--json]

const fs = require('fs');
const { deriveVariant, deriveExclusive } = require('./src/recorder/parsers');

class ReplayError extends Error {}

// Parse JSONL text into events. A line that fails to parse means the file was
// truncated/corrupted mid-write — that is a hard, loud failure.
function parseJsonl(text) {
  const lines = text.split(/\r?\n/);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // tolerate trailing newline / blank lines
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      throw new ReplayError(`truncated/corrupt JSONL at line ${i + 1}: ${err.message}\n  >> ${line.slice(0, 120)}`);
    }
  }
  return events;
}

// Reconstruct timeline. opts: { stripeTemplateId, line2Field, exclusiveField }
function reconstruct(events, opts = {}) {
  if (!events.length) throw new ReplayError('empty recording (no events)');

  // Pull config from the session header when present.
  const header = events.find((e) => e.type === 'session' && e.event === 'start');
  if (!header) throw new ReplayError('no "session start" header — not a valid recording');
  const cfg = header.config || {};
  const stripeTemplateId = opts.stripeTemplateId != null ? String(opts.stripeTemplateId)
    : (cfg.stripeTemplateId != null ? String(cfg.stripeTemplateId) : null);
  const line2Field = opts.line2Field != null ? String(opts.line2Field) : String(cfg.line2Field != null ? cfg.line2Field : '1');
  const exclusiveField = opts.exclusiveField != null ? opts.exclusiveField : (cfg.exclusiveField != null ? cfg.exclusiveField : null);

  const sessionStopped = events.some((e) => e.type === 'session' && e.event === 'stop');

  const open = new Map();      // elementId -> instance being built
  const completed = [];

  const isStripe = (templateId, flag) => {
    if (typeof flag === 'boolean') return flag;
    return stripeTemplateId != null && templateId != null && String(templateId) === stripeTemplateId;
  };

  const snapshot = (content) => ({
    variant: content ? deriveVariant(content, line2Field) : null,
    exclusive: content ? deriveExclusive(content, exclusiveField) : null,
    texts: content ? content.texts : null,
    fields: content ? content.fields : null,
    contentPending: !content,
  });

  for (const e of events) {
    if (e.type === 'take') {
      const inst = {
        elementId: e.elementId,
        templateId: e.templateId,
        isStripe: isStripe(e.templateId, e.isStripe),
        tookAt: e.ts,
        leftAt: null,
        stillOnAir: false,
        initial: snapshot(e.content),
        timeline: [{ at: e.ts, kind: 'take', ...snapshot(e.content) }],
      };
      open.set(e.elementId, inst);
    } else if (e.type === 'change') {
      const inst = open.get(e.elementId);
      if (inst) inst.timeline.push({ at: e.ts, kind: 'change', ...snapshot(e.content) });
    } else if (e.type === 'off-air') {
      const inst = open.get(e.elementId);
      if (inst) {
        inst.leftAt = e.ts;
        inst.timeline.push({ at: e.ts, kind: 'off-air' });
        completed.push(inst);
        open.delete(e.elementId);
      }
    }
  }

  // Any instance still open at end-of-file: legitimate only if the recording
  // ended cleanly (session stop = still on air when we stopped). Otherwise the
  // file was truncated — fail loudly.
  for (const inst of open.values()) {
    if (!sessionStopped) {
      throw new ReplayError(
        `dangling on-air element ${inst.elementId} (took ${inst.tookAt}, never went off-air, no session stop) `
        + '— recording is truncated/incomplete');
    }
    inst.stillOnAir = true;
    completed.push(inst);
  }

  const stripeInstances = completed.filter((i) => i.isStripe);
  return { stripeTemplateId, line2Field, exclusiveField, sessionStopped, all: completed, stripe: stripeInstances };
}

function summarizeInstance(inst) {
  const variants = [];
  for (const t of inst.timeline) {
    if (t.kind === 'off-air') continue;
    const last = variants[variants.length - 1];
    if (!last || last.variant !== t.variant || last.exclusive !== t.exclusive) {
      variants.push({ at: t.at, variant: t.variant, exclusive: t.exclusive, texts: t.texts });
    }
  }
  return {
    elementId: inst.elementId,
    templateId: inst.templateId,
    tookAt: inst.tookAt,
    leftAt: inst.leftAt,
    stillOnAir: inst.stillOnAir,
    states: variants,
  };
}

function printTimeline(result) {
  console.log(`\n=== Stripe timeline (template ${result.stripeTemplateId ?? 'unset'}; line2Field=${result.line2Field}) ===`);
  if (!result.stripe.length) {
    console.log('(no Stripe instances found)');
  }
  result.stripe.forEach((inst, i) => {
    const s = summarizeInstance(inst);
    console.log(`\nStripe instance #${i + 1}  element ${s.elementId}  template ${s.templateId}`);
    console.log(`  took: ${s.tookAt}`);
    console.log(`  left: ${s.leftAt || (s.stillOnAir ? '(still on air at recording end)' : 'unknown')}`);
    s.states.forEach((st) => {
      const ex = st.exclusive == null ? '' : `  exclusive=${st.exclusive ? 'ON' : 'off'}`;
      const txt = st.texts ? st.texts.join(' | ') : '(content pending)';
      console.log(`   @${st.at}  ${st.variant || 'PENDING'}${ex}  "${txt}"`);
    });
  });
  console.log(`\nTotal instances: ${result.all.length} (Stripe: ${result.stripe.length}); session ${result.sessionStopped ? 'closed cleanly' : 'NOT closed'}`);
}

function replayFile(filePath, opts = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const events = parseJsonl(text);
  return reconstruct(events, opts);
}

module.exports = { parseJsonl, reconstruct, replayFile, summarizeInstance, ReplayError };

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
    console.error('usage: node replay.js <file.jsonl> [--stripe-template ID] [--line2-field N] [--json]'
      + ' [--emit [--out PATH]] [--report]');
    process.exit(2);
  }
  try {
    const opts = {
      stripeTemplateId: getFlag('stripe-template'),
      line2Field: getFlag('line2-field'),
      exclusiveField: getFlag('exclusive-field'),
    };
    // Stage 3: --emit writes the normalized Stage-4 bridge contract; --report
    // prints the sufficiency check. Both delegate to timeline.js.
    if (argv.includes('--emit') || argv.includes('--report')) {
      const { emitFile, reportFile, formatReport } = require('./timeline');
      opts.sourceLabel = file.replace(/\\/g, '/').split('/').pop();
      if (argv.includes('--report')) console.log(formatReport(reportFile(file, opts)));
      if (argv.includes('--emit')) {
        const json = JSON.stringify(emitFile(file, opts), null, 2);
        const out = getFlag('out');
        if (out) { fs.writeFileSync(out, json + '\n'); console.error(`wrote ${out}`); }
        else console.log(json);
      }
      process.exit(0);
    }
    const result = replayFile(file, opts);
    if (argv.includes('--json')) {
      console.log(JSON.stringify(result.stripe.map(summarizeInstance), null, 2));
    } else {
      printTimeline(result);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof ReplayError) {
      console.error(`\n❌ REPLAY FAILED: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
