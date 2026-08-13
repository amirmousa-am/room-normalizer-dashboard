// ============================================================
// Room Normalizer — ENGINE CORE (ported from room-normalizer-panel.user.js
// v1.8.0 — source has no GM_/DOM/network calls in the functions below,
// so this is a byte-for-byte logic port. Do not hand-edit parsing behavior
// here without also updating the userscript, or the two engines will
// silently diverge and the regression suite becomes meaningless.
//
// What changed vs the userscript, and why:
//   - `normalize(rawName, options)` in the userscript calls `await init()`
//     internally (GM cache + Supabase fetch) to obtain `dict`. That adapter
//     code is Tampermonkey-only and is NOT ported. Instead, `normalizeCore`
//     below takes `dict` as an explicit parameter — the dashboard's caller
//     is responsible for calling `buildLookup()` and passing the result in.
//   - `createCollector()` used `GM_xmlhttpRequest` to POST to Supabase.
//     Ported version takes a Supabase client and calls `.rpc()` instead.
//   - Everything else (sanitize, tokenize, pass1..pass3, assemble,
//     buildTokenExplanations, TOKEN_STATUS) is unchanged pipeline logic.
//
// KNOWN ARCHITECTURAL QUIRK (inherited from the source, not introduced here):
// buildLookup() does not return a fully self-contained dictionary snapshot.
// It also repopulates several module-level Sets (DYNAMIC_VIEW_CORE, etc.)
// that later pipeline stages (isViewCore/isViewMod/isViewModPositional) read
// directly. That means you cannot have two "live" dictionaries in memory at
// once — calling buildLookup(dictB) while dictA is still "active" will make
// dictA's downstream parsing wrong. The Dictionary Manager's save-blocking
// regression check must therefore run strictly sequentially: build the
// proposed dict, run the suite, then rebuild the real live dict again before
// anything else uses the engine. See dictionaryManager.js for how this is
// handled.
// ============================================================

export const ENGINE_VERSION = "1.8.0-dashboard-port";

// ------------------------------------------------------------
// Two independent, parallel diagnostic sidecars (verbatim from source)
// ------------------------------------------------------------
function diagnosticToken(token) {
  return {
    index: token.idx,
    text: token.text,
    claimedBy: token.claimedBy,
    resolved: token.resolved ? { ...token.resolved } : null,
  };
}

class DiagnosticCollector {
  constructor() { this.events = []; this.nextId = 1; }
  emit(stage, type, tokens, explanation, metadata) {
    const event = { id: `diag_${this.nextId++}`, stage, type, tokens: (tokens || []).map(diagnosticToken), explanation };
    if (metadata !== undefined) event.metadata = metadata;
    this.events.push(event);
  }
  snapshot(stage, tokens) {
    this.emit(stage, "trace.snapshot", tokens, "Token state after this stage.");
  }
  report() { return { version: 1, events: this.events }; }
}

function snapshotTokens(tokens) {
  return tokens.map((t) => ({
    text: t.text,
    position: t.idx,
    claimed_by: t.claimedBy,
    resolved: t.resolved ? { ...t.resolved } : null,
  }));
}

function createDiagnostics(rawName, traceEnabled) {
  const diagnostics = [];
  const ruleHits = new Map();
  const trace = [];
  return {
    stage(name, tokens, details = null) {
      if (traceEnabled) trace.push({ stage: name, tokens: snapshotTokens(tokens), details });
    },
    review(event) {
      diagnostics.push({ severity: "review", ...event });
    },
    ruleHit(ruleKey, termId = null) {
      const key = `${ruleKey}|${termId || ""}`;
      const previous = ruleHits.get(key);
      ruleHits.set(key, {
        rule_key: ruleKey,
        term_id: termId,
        hit_count: (previous?.hit_count || 0) + 1,
      });
    },
    result() {
      return { diagnostics, rule_hits: [...ruleHits.values()], trace };
    },
  };
}

// ------------------------------------------------------------
// Collector — ADAPTER CHANGE from source: takes a Supabase client instead
// of using GM_xmlhttpRequest. Aggregation logic (Map-based merge) unchanged.
// ------------------------------------------------------------
const REVIEW_SAMPLE_LIMIT = 5;

export function createCollector(source, supabase) {
  const reviewEvents = new Map();
  const ruleHits = new Map();
  const errorEvents = [];
  let processedCount = 0;

  function addReview(diagnostic, rawName) {
    if (!diagnostic.token || !diagnostic.kind) return;
    const token = diagnostic.token.toLowerCase().trim();
    const key = `${diagnostic.kind}|${token}|${diagnostic.code || ""}`;
    const event = reviewEvents.get(key) || {
      token,
      kind: diagnostic.kind,
      diagnostic_code: diagnostic.code || null,
      explanation: diagnostic.explanation || null,
      occurrence_count: 0,
      sample_raw_names: [],
    };
    event.occurrence_count += 1;
    if (rawName && !event.sample_raw_names.includes(rawName) && event.sample_raw_names.length < REVIEW_SAMPLE_LIMIT) {
      event.sample_raw_names.push(rawName);
    }
    reviewEvents.set(key, event);
  }

  return {
    recordResult(result) {
      processedCount += 1;
      for (const diagnostic of result.diagnostics || []) addReview(diagnostic, result.raw_name);
      for (const hit of result.rule_hits || []) {
        const key = `${hit.rule_key}|${hit.term_id || ""}`;
        const current = ruleHits.get(key) || { ...hit, hit_count: 0 };
        current.hit_count += hit.hit_count;
        ruleHits.set(key, current);
      }
    },
    recordError(rawName, error) {
      errorEvents.push({
        raw_name: rawName,
        error_message: error?.message || String(error),
        stack: error?.stack || null,
      });
    },
    async flush() {
      if (!processedCount && !errorEvents.length) return;
      const payload = {
        p_run: { source, engine_version: ENGINE_VERSION, processed_count: processedCount },
        p_review_events: [...reviewEvents.values()],
        p_rule_hits: [...ruleHits.values()],
        p_error_events: errorEvents,
      };
      const { error } = await supabase.rpc("collect_normalizer_batch", payload);
      if (error) throw error;
      reviewEvents.clear();
      ruleHits.clear();
      errorEvents.length = 0;
      processedCount = 0;
    },
  };
}

// ============================================================
// ENGINE HELPERS & STRUCTURAL ANCHORS (verbatim)
// ============================================================
const BED_ANCHOR = new Set(["bed", "beds", "bd", "bds"]);
const BEDROOM_ANCHOR = new Set(["bdrm", "bdrms", "bedroom", "bedrooms", "bdr", "bdrs", "br", "brs"]);
const VIEW_ANCHOR = new Set(["view", "vw", "vws"]);
const OCCUPANCY_ANCHORS = new Set(["pax", "guest", "guests", "adult", "adults", "person", "persons", "people"]);

const DYNAMIC_BED_TYPES = new Set();
const DYNAMIC_VIEW_CORE = new Set();
const DYNAMIC_VIEW_MOD = new Set();
const DYNAMIC_VIEW_MOD_POSITIONAL = new Set();
const VIEW_COMPOUND_VOCAB = new Set();
const EXPANSIONS = new Map();

const WORD_NUMBERS = new Map([
  ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10],
]);

function parseNumber(text) {
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  return WORD_NUMBERS.get(text.toLowerCase()) || null;
}

// ------------------------------------------------------------
// buildLookup(rows) — verbatim from source, INCLUDING the module-level
// global-Set side effect. See the architectural-quirk note at the top
// of this file before calling this twice in the same tick.
// ------------------------------------------------------------
export function buildLookup(rows) {
  const lookup = new Map();
  let maxPhraseLen = 1;

  DYNAMIC_BED_TYPES.clear();
  DYNAMIC_VIEW_CORE.clear();
  DYNAMIC_VIEW_MOD.clear();
  DYNAMIC_VIEW_MOD_POSITIONAL.clear();
  VIEW_COMPOUND_VOCAB.clear();
  EXPANSIONS.clear();

  for (const row of rows) {
    for (const rawSyn of row.synonyms.split(",")) {
      const syn = rawSyn.trim().toLowerCase().replace(/\s+/g, " ");
      if (!syn) continue;

      if (row.action === "EXPAND") {
        EXPANSIONS.set(syn, (row.canonical_term || "").toLowerCase());
        continue;
      }

      lookup.set(syn, { termId: row.id, canonical: row.canonical_term, category: row.category, action: row.action });
      maxPhraseLen = Math.max(maxPhraseLen, syn.split(" ").length);

      if (row.category === "BEDDING_TYPE") {
        DYNAMIC_BED_TYPES.add(syn);
        if (row.canonical_term) DYNAMIC_BED_TYPES.add(row.canonical_term.toLowerCase());
      } else if (row.category === "VIEW_CORE") {
        DYNAMIC_VIEW_CORE.add(syn);
        if (row.canonical_term) DYNAMIC_VIEW_CORE.add(row.canonical_term.toLowerCase());
      } else if (row.category === "VIEW_MODIFIER") {
        DYNAMIC_VIEW_MOD.add(syn);
        if (row.canonical_term) DYNAMIC_VIEW_MOD.add(row.canonical_term.toLowerCase());
      } else if (row.category === "VIEW_MODIFIER_POSITIONAL") {
        DYNAMIC_VIEW_MOD_POSITIONAL.add(syn);
        if (row.canonical_term) DYNAMIC_VIEW_MOD_POSITIONAL.add(row.canonical_term.toLowerCase());
      }
    }
  }

  for (const w of DYNAMIC_VIEW_CORE) VIEW_COMPOUND_VOCAB.add(w);
  for (const w of DYNAMIC_VIEW_MOD) VIEW_COMPOUND_VOCAB.add(w);
  for (const w of DYNAMIC_VIEW_MOD_POSITIONAL) VIEW_COMPOUND_VOCAB.add(w);
  for (const w of VIEW_ANCHOR) VIEW_COMPOUND_VOCAB.add(w);

  return { lookup, maxPhraseLen };
}

function sanitize(raw, diag) {
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9\s/]/g, " ").replace(/\s+/g, " ").trim();
  if (sanitized !== raw) diag?.emit("sanitize", "input.sanitized", [], "Input text was normalized before tokenization.", { raw, sanitized });
  return sanitized;
}

function splitFusedViewWord(word, dict) {
  if (word.length < 6) return null;
  if (dict.lookup.has(word)) return null;
  for (let i = 3; i <= word.length - 3; i++) {
    const left = word.slice(0, i);
    const right = word.slice(i);
    if (VIEW_COMPOUND_VOCAB.has(left) && VIEW_COMPOUND_VOCAB.has(right)) return `${left} ${right}`;
  }
  return null;
}

function expandCompounds(sanitized, dict, diag) {
  const words = sanitized.split(" ");
  const out = [];
  for (const [idx, w] of words.entries()) {
    if (EXPANSIONS.has(w)) {
      const expansion = EXPANSIONS.get(w);
      diag?.emit("expandCompounds", "compound.expanded", [{ idx, text: w, claimedBy: null, resolved: null }], "A manual expansion dictionary entry split this compound.", { expansion, source: "manual" });
      out.push(expansion);
      continue;
    }
    const split = splitFusedViewWord(w, dict);
    if (split) diag?.emit("expandCompounds", "compound.expanded", [{ idx, text: w, claimedBy: null, resolved: null }], "The view vocabulary splitter split this compound.", { expansion: split, source: "view_vocabulary" });
    out.push(split || w);
  }
  return out.join(" ");
}

function tokenize(raw, dict, diag) {
  const sanitized = sanitize(raw, diag);
  const expanded = expandCompounds(sanitized, dict, diag);
  const tokens = expanded.split(" ").filter(Boolean).map((text, idx) => ({ text, idx, claimedBy: null, resolved: null }));
  diag?.emit("tokenize", "tokens.created", tokens, "Input was split into parser tokens.");
  return { tokens, sanitized, expanded };
}

function* unclaimedWindows(tokens, maxLen) {
  const n = tokens.length;
  for (let length = maxLen; length >= 1; length--) {
    for (let start = 0; start + length <= n; start++) {
      const window = tokens.slice(start, start + length);
      if (window.every((t) => t.claimedBy === null)) yield { start, end: start + length, window };
    }
  }
}

function* patternWindows(tokens, maxLen) {
  const n = tokens.length;
  for (let length = maxLen; length >= 1; length--) {
    for (let start = 0; start + length <= n; start++) {
      const window = tokens.slice(start, start + length);
      if (window.every((t) => t.claimedBy === null || t.claimedBy.startsWith("dict:"))) {
        yield { start, end: start + length, window };
      }
    }
  }
}

function claim(tokens, start, end, ruleName) {
  for (let i = start; i < end; i++) tokens[i].claimedBy = ruleName;
}

function tokenAvailable(t) {
  return t.claimedBy === null || t.claimedBy.startsWith("dict:");
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

function pass1(tokens, dict, diag, telemetry) {
  for (const { start, end, window } of unclaimedWindows(tokens, dict.maxPhraseLen)) {
    const phrase = window.map((t) => t.text).join(" ");
    const match = dict.lookup.get(phrase);
    if (!match) continue;
    const { termId, canonical, category, action } = match;
    telemetry?.ruleHit(`DICT:${termId || `${category}:${phrase}`}`, termId || null);
    if (action === "DELETE") {
      claim(tokens, start, end, `dict:${category}:DELETE`);
      diag?.emit("pass1_dictionary", "dictionary.match", window, "A dictionary DELETE rule claimed these tokens.", { termId, phrase, canonical, category, action });
      continue;
    }
    if (window.length === 1) {
      window[0].text = canonical ? canonical.toLowerCase() : window[0].text;
      window[0].resolved = { termId, canonical, category, action };
    } else {
      claim(tokens, start, end, `dict:${category}:REPLACE`);
      window.forEach((t) => (t.resolved = { termId, canonical, category, action }));
    }
    diag?.emit("pass1_dictionary", "dictionary.match", window, "A dictionary entry resolved these tokens.", { termId, phrase, canonical, category, action });
  }
  if (diag) {
    for (const token of tokens) {
      if (token.claimedBy === null && token.resolved === null) {
        diag.emit("pass1_dictionary", "dictionary.miss", [token], "No dictionary entry matched this token.", { token: token.text });
      }
    }
  }
}

function compact(tokens, diag) {
  return tokens.filter((t) => {
    if (!(t.claimedBy && t.claimedBy.endsWith(":DELETE"))) return true;
    if (BED_ANCHOR.has(t.text) || BEDROOM_ANCHOR.has(t.text) || VIEW_ANCHOR.has(t.text)) return true;
    diag?.emit("compact", "token.dropped", [t], "A dictionary DELETE rule removed this non-structural token before pattern matching.", { claim: t.claimedBy });
    return false;
  });
}

function pass2Bedroom(tokens) {
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length === 2) {
      const [a, b] = window;
      const num = parseNumber(a.text);
      if (num !== null && BEDROOM_ANCHOR.has(b.text)) {
        claim(tokens, start, end, "R_BDR");
        return `${num} Bedroom`;
      }
    }
  }
  for (const { start, end, window } of patternWindows(tokens, 1)) {
    if (BEDROOM_ANCHOR.has(window[0].text)) { claim(tokens, start, end, "R_BDR_DROP"); return null; }
  }
  return null;
}

function pass2OccupancyPattern(tokens) {
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length === 2) {
      const num = parseNumber(window[0].text);
      if (num !== null && OCCUPANCY_ANCHORS.has(window[1].text)) {
        claim(tokens, start, end, "R_OCCUPANCY");
        return `${num} Pax`;
      }
    }
  }
  return null;
}

function isBedTypeToken(t) {
  if (t.resolved && t.resolved.category !== "BEDDING_TYPE") return false;
  const canon = (t.resolved?.canonical || t.text).toLowerCase();
  return ["double", "single", "twin", "king", "queen", "full"].includes(canon) ||
         DYNAMIC_BED_TYPES.has(t.text) ||
         t.resolved?.category === "BEDDING_TYPE";
}

function pass2BeddingSingle(tokens) {
  const n = tokens.length;
  for (let i = 0; i < n; i++) {
    const t = tokens[i];
    if (!tokenAvailable(t) || !isBedTypeToken(t)) continue;

    const prev = i > 0 ? tokens[i - 1] : null;
    const next = i < n - 1 ? tokens[i + 1] : null;
    const prevNum = prev && tokenAvailable(prev) ? parseNumber(prev.text) : null;
    const nextIsAnchor = !!(next && tokenAvailable(next) && BED_ANCHOR.has(next.text));

    let start, end, count, hasNum = false, hasAnchor = false;
    if (prevNum !== null && nextIsAnchor) {
      start = i - 1; end = i + 2; count = prevNum; hasNum = true; hasAnchor = true;
    } else if (prevNum !== null) {
      start = i - 1; end = i + 1; count = prevNum; hasNum = true;
    } else if (nextIsAnchor) {
      start = i; end = i + 2; count = 1; hasAnchor = true;
    } else {
      start = i; end = i + 1; count = 1;
    }

    const canonType = (t.resolved?.canonical || t.text).toLowerCase();
    const isAmbiguous = ["double", "single", "twin"].includes(canonType);
    if (isAmbiguous && !hasNum && !hasAnchor) continue;

    claim(tokens, start, end, "R_BED");
    const bedTypeName = t.resolved?.canonical || cap(t.text);
    const bedLabel = count > 1 ? "Beds" : "Bed";
    return `${count} ${bedTypeName} ${bedLabel}`;
  }
  return null;
}

function pass2BeddingAll(tokens) {
  const results = [];
  let match;
  while ((match = pass2BeddingSingle(tokens)) !== null) results.push(match);
  return results;
}

function isViewCore(t) { return DYNAMIC_VIEW_CORE.has(t.text) || t.resolved?.category === "VIEW_CORE"; }
function isViewMod(t) { return DYNAMIC_VIEW_MOD.has(t.text) || t.resolved?.category === "VIEW_MODIFIER"; }
function isViewModPositional(t) { return DYNAMIC_VIEW_MOD_POSITIONAL.has(t.text) || t.resolved?.category === "VIEW_MODIFIER_POSITIONAL"; }
function isAnyMod(t) { return isViewMod(t) || isViewModPositional(t); }

function fmtView(modifierToken, coreToken) {
  const coreVal = coreToken.resolved?.canonical || cap(coreToken.text);
  const modVal = modifierToken ? (modifierToken.resolved?.canonical || cap(modifierToken.text)) : "";
  return `${modVal ? modVal + " " : ""}${coreVal} View`;
}
function fmtLiteralNoView(coreToken, modifierToken) {
  const coreVal = coreToken.resolved?.canonical || cap(coreToken.text);
  const modVal = modifierToken.resolved?.canonical || cap(modifierToken.text);
  return `${coreVal} ${modVal}`;
}

function pass2ViewSingle(tokens) {
  for (const { start, end, window } of patternWindows(tokens, 3)) {
    if (window.length !== 3) continue;
    const [a, b, c] = window;
    if (!VIEW_ANCHOR.has(c.text)) continue;
    if (isAnyMod(a) && isViewCore(b)) { claim(tokens, start, end, "R_VIEW"); return fmtView(a, b); }
    if (isViewCore(a) && isAnyMod(b)) { claim(tokens, start, end, "R_VIEW"); return fmtView(b, a); }
  }
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length !== 2) continue;
    const [a, b] = window;
    if (VIEW_ANCHOR.has(b.text) && isViewCore(a)) { claim(tokens, start, end, "R_VIEW"); return fmtView(null, a); }
    if (VIEW_ANCHOR.has(a.text) && isViewCore(b)) { claim(tokens, start, end, "R_VIEW"); return fmtView(null, b); }
  }
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length !== 2) continue;
    const [a, b] = window;
    if (isViewCore(a) && isViewMod(b)) { claim(tokens, start, end, "R_VIEW"); return fmtView(b, a); }
    if (isViewMod(a) && isViewCore(b)) { claim(tokens, start, end, "R_VIEW"); return fmtView(a, b); }
  }
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length !== 2) continue;
    const [a, b] = window;
    if (isViewCore(a) && isViewModPositional(b)) { claim(tokens, start, end, "R_VIEW"); return fmtLiteralNoView(a, b); }
    if (isViewModPositional(a) && isViewCore(b)) { claim(tokens, start, end, "R_VIEW"); return fmtView(a, b); }
  }
  return null;
}

function pass2ViewAll(tokens) {
  const results = [];
  let match;
  while ((match = pass2ViewSingle(tokens)) !== null) results.push(match);
  return results;
}

function pass2TwinSpecial(tokens) {
  for (const length of [3, 2]) {
    for (const { start, end, window } of patternWindows(tokens, length)) {
      if (window.length !== length) continue;
      const texts = window.map((t) => t.text);
      let count = null, twinIdx;
      if (length === 3) {
        const n = parseNumber(texts[0]);
        if (n === null || texts[1] !== "twin") continue;
        count = n; twinIdx = 1;
      } else {
        if (texts[0] !== "twin") continue;
        twinIdx = 0;
      }
      const second = texts[twinIdx + 1];
      if (BED_ANCHOR.has(second)) {
        claim(tokens, start, end, "TWIN_BED");
        const isPluralAnchor = second === "beds" || second === "bds";
        const n = count || (isPluralAnchor ? 2 : 1);
        return { bedding: `${n} Single ${n === 1 ? "Bed" : "Beds"}`, extraType: null };
      }
      if (second === "room" || second === "rm") {
        claim(tokens, start, end, "TWIN_ROOM");
        return { bedding: "2 Single Beds", extraType: "Room" };
      }
    }
  }
  return { bedding: null, extraType: null };
}

function pass2DropAmbiguous(tokens, diag, telemetry) {
  for (const t of tokens) {
    if (t.claimedBy === null || t.claimedBy.startsWith("dict:")) {
      const canonMatch = (t.resolved?.canonical || t.text).toLowerCase();
      if (canonMatch === "double") {
        t.claimedBy = "R_DROP_DOUBLE";
        telemetry?.ruleHit("ENGINE:R_DROP_DOUBLE");
        telemetry?.review({
          kind: "AMBIGUOUS_DROP",
          code: "R_DROP_DOUBLE",
          token: t.text,
          phase: "pass2",
          explanation: "The token matched \u2018Double\u2019 but had no adjacent number or bed anchor, so the engine dropped it as ambiguous.",
        });
        diag?.emit("pass2DropAmbiguous", "token.dropped", [t], "An unconsumed \u2018Double\u2019 token was dropped because it lacked explicit bedding context.", { rule: "R_DROP_DOUBLE", canonical: canonMatch });
      } else if (canonMatch === "single") {
        t.resolved = { termId: t.resolved?.termId || null, canonical: "Single", category: "OCCUPANCY", action: "REPLACE" };
        telemetry?.ruleHit("ENGINE:R_RECLASSIFY_SINGLE");
        diag?.emit("pass2DropAmbiguous", "token.reclassified", [t], "An unconsumed \u2018Single\u2019 token was reclassified as occupancy because it lacked explicit bedding context.", { rule: "R_RECLASSIFY_SINGLE", canonical: "Single", category: "OCCUPANCY" });
      }
    }
  }
}

function pass3(tokens, auditSink, rawName, diag, telemetry) {
  const buckets = { class: [], occupancy: [], type: [], building: [], amenity: [], custom: [] };
  for (const t of tokens) {
    if (t.claimedBy !== null && !t.claimedBy.startsWith("dict:")) continue;
    if (t.claimedBy !== null && t.claimedBy.endsWith(":DELETE")) continue;
    if (t.resolved) {
      const { canonical, category } = t.resolved;
      if (category === "CLASS") buckets.class.push(canonical);
      else if (category === "OCCUPANCY") buckets.occupancy.push(canonical);
      else if (category === "TYPE") buckets.type.push(canonical);
      else if (category === "BUILDING") buckets.building.push(canonical);
      else if (category === "AMENITY" || category === "PRIVILEGE") buckets.amenity.push(canonical);
      else if (category === "VIEW_CORE" || category === "VIEW_MODIFIER" || category === "VIEW_MODIFIER_POSITIONAL") {
        if (canonical) {
          buckets.custom.push(canonical);
          telemetry?.review({
            kind: "UNPAIRED_SEMANTIC",
            code: "UNPAIRED_VIEW",
            token: t.text,
            phase: "pass3",
            explanation: `The dictionary recognized \u2018${canonical}\u2019 as a view term, but no valid view pattern consumed it.`,
          });
        }
      } else if (category === "BEDDING_TYPE") {
        if (canonical) {
          buckets.custom.push(canonical);
          telemetry?.review({
            kind: "UNPAIRED_SEMANTIC",
            code: "UNPAIRED_BEDDING",
            token: t.text,
            phase: "pass3",
            explanation: `The dictionary recognized \u2018${canonical}\u2019 as a bedding term, but no valid bedding pattern consumed it.`,
          });
        }
      }
      continue;
    }
    buckets.custom.push(cap(t.text));
    if (auditSink) auditSink(t.text, rawName);
    telemetry?.review({
      kind: "UNRESOLVED",
      code: "NO_DICTIONARY_MATCH",
      token: t.text,
      phase: "pass3",
      explanation: "No dictionary entry or structural rule recognized this token.",
    });
    diag?.emit("pass3", "token.unresolved", [t], "No dictionary or structural rule resolved this token, so it was emitted as custom output.", { bucket: "custom" });
  }
  return { buckets };
}

function dedup(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr) if (x && !seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function assemble(buckets, bedroom, beddingList, viewList) {
  let classList = dedup(buckets.class);
  if (classList.length === 0) classList = ["Standard"];

  const occupancyList = dedup(buckets.occupancy);

  let typeList = dedup(buckets.type);
  if (typeList.length === 0) typeList = ["Room"];

  const buildingList = dedup(buckets.building);
  const amenityList = dedup(buckets.amenity);
  const customList = dedup(buckets.custom);

  const beddingClean = dedup(beddingList || []);
  const viewClean = dedup(viewList || []);
  const beddingLine = beddingClean.length ? beddingClean.join(", ") : null;
  const viewLine = viewClean.length ? viewClean.join(", ") : null;

  const parts = [...classList];
  if (occupancyList.length) parts.push(...occupancyList);
  parts.push(...typeList);
  if (bedroom) parts.push(bedroom);
  if (beddingLine) parts.push(beddingLine);
  if (viewLine) parts.push(viewLine);
  parts.push(...buildingList, ...amenityList, ...customList);

  const canonical_string = parts.join(" ");
  const canonical_hash = await sha256(canonical_string);
  return {
    canonical_string, canonical_hash,
    parsed_components: {
      class: classList,
      occupancy: occupancyList.length ? occupancyList.join(", ") : null,
      type: typeList,
      bedroom: bedroom || null,
      bedding: beddingLine,
      view: viewLine,
      building: buildingList.length ? buildingList : null,
      amenity: amenityList.length ? amenityList : null,
      custom: customList,
    },
  };
}

// ============================================================
// normalizeCore(rawName, dict, options) — the pure entry point.
// This replaces the userscript's `normalize(rawName, options)`, with the
// `await init()` call removed and `dict` taken as a parameter instead.
// Everything after that line is identical to the source.
// ============================================================
let LAST_DIAGNOSTICS = null;

export function getLastDiagnostics() {
  return LAST_DIAGNOSTICS;
}

export async function normalizeCore(rawName, dict, options = {}) {
  const diag = new DiagnosticCollector();
  const telemetry = createDiagnostics(rawName, options.trace === true);

  const { tokens: initialTokens, sanitized, expanded } = tokenize(rawName, dict, diag);
  let tokens = initialTokens;
  telemetry.stage("tokenize", tokens, { sanitized, expanded });

  pass1(tokens, dict, diag, telemetry);
  diag.snapshot("pass1_dictionary", tokens);
  telemetry.stage("pass1_dictionary", tokens);

  tokens = compact(tokens, diag);
  diag.snapshot("compact", tokens);
  telemetry.stage("compact", tokens);

  const bedroom = pass2Bedroom(tokens);
  diag.emit("pass2Bedroom", "stage.completed", tokens, "Bedroom pattern pass completed.", { output: bedroom });
  if (tokens.some((t) => t.claimedBy === "R_BDR")) telemetry.ruleHit("ENGINE:R_BDR");
  if (tokens.some((t) => t.claimedBy === "R_BDR_DROP")) telemetry.ruleHit("ENGINE:R_BDR_DROP");

  const twin = pass2TwinSpecial(tokens);
  diag.emit("pass2TwinSpecial", "stage.completed", tokens, "Twin-specific pattern pass completed.", { bedding: twin.bedding, extraType: twin.extraType });
  if (twin.bedding || twin.extraType) telemetry.ruleHit(`ENGINE:${twin.extraType ? "TWIN_ROOM" : "TWIN_BED"}`);

  const beddingList = [
    ...(twin.bedding ? [twin.bedding] : []),
    ...pass2BeddingAll(tokens),
  ];
  diag.emit("pass2BeddingAll", "stage.completed", tokens, "Bedding pattern pass completed.", { output: beddingList });
  for (let i = 0; i < beddingList.length - (twin.bedding ? 1 : 0); i++) telemetry.ruleHit("ENGINE:R_BED");

  const viewList = pass2ViewAll(tokens);
  diag.emit("pass2ViewAll", "stage.completed", tokens, "View pattern pass completed.", { output: viewList });
  for (let i = 0; i < viewList.length; i++) telemetry.ruleHit("ENGINE:R_VIEW");

  const ruleOccupancy = pass2OccupancyPattern(tokens);
  diag.emit("pass2OccupancyPattern", "stage.completed", tokens, "Occupancy pattern pass completed.", { output: ruleOccupancy });
  if (ruleOccupancy) telemetry.ruleHit("ENGINE:R_OCCUPANCY");

  diag.snapshot("pass2_structural", tokens);
  telemetry.stage("pass2_structural", tokens, { bedroom, twin, bedding: beddingList, views: viewList, occupancy: ruleOccupancy });

  pass2DropAmbiguous(tokens, diag, telemetry);
  diag.snapshot("pass2DropAmbiguous", tokens);
  telemetry.stage("pass2_ambiguity", tokens);

  const { buckets } = pass3(tokens, options.auditSink, rawName, diag, telemetry);
  telemetry.stage("pass3_buckets", tokens, { buckets });
  if (ruleOccupancy) buckets.occupancy.push(ruleOccupancy);
  if (twin.extraType) buckets.type.push(twin.extraType);
  diag.snapshot("pass3", tokens);

  const result = await assemble(buckets, bedroom, beddingList, viewList);
  result.raw_name = rawName;

  Object.assign(result, telemetry.result());

  LAST_DIAGNOSTICS = diag.report();
  if (options.diagnostics === false) {
    // Heavy per-token UI trace is skipped for high-volume (bulk) runs, matching
    // the userscript's options.diagnostics contract. result.diagnostics/rule_hits
    // (the aggregatable telemetry) are unaffected and always populated above.
    result.diagnosticsReport = null;
  } else {
    result.diagnosticsReport = LAST_DIAGNOSTICS;
  }

  return result;
}

// ============================================================
// TOKEN EXPLANATION REDUCER (verbatim from source) — drives the Playground's
// Token Decisions UI. Reference implementation, do not reimplement.
// ============================================================
export const TOKEN_STATUS = {
  matched: { label: "Matched", badgeClass: "rn-badge-matched", chipClass: "rn-chip-matched", icon: "\u2713" },
  unresolved: { label: "Unresolved", badgeClass: "rn-badge-unresolved", chipClass: "rn-chip-unresolved", icon: "\u26a0" },
  dropped: { label: "Dropped", badgeClass: "rn-badge-dropped", chipClass: "rn-chip-dropped", icon: "\u2193" },
  reclassified: { label: "Reclassified", badgeClass: "rn-badge-reclassified", chipClass: "rn-chip-reclassified", icon: "\u2194" },
  noise_removed: { label: "Noise removed", badgeClass: "rn-badge-noise_removed", chipClass: "rn-chip-noise_removed", icon: "\u00d7" },
  anchor: { label: "Anchor", badgeClass: "rn-badge-anchor", chipClass: "rn-chip-anchor", icon: "\u21b3" },
};

export function buildTokenExplanations(report, result) {
  if (!report || !report.events) return [];

  const tokenMap = new Map();
  const executedStages = [];

  const tokenizeEvent = report.events.find((e) => e.stage === "tokenize" && e.type === "tokens.created");
  if (tokenizeEvent && tokenizeEvent.tokens) {
    for (const t of tokenizeEvent.tokens) {
      tokenMap.set(t.index, {
        index: t.index,
        text: t.text,
        status: "unresolved",
        sanitized: true,
        compoundExpanded: false,
        expansionInfo: null,
        dictionaryMatch: null,
        dictionaryMiss: false,
        claimedRule: null,
        droppedReason: null,
        reclassifiedInfo: null,
        isNoiseRemoved: false,
        isAnchor: false,
        isUnresolved: false,
        lifecycle: [],
        finalComponent: null,
      });
    }
  }

  for (const ev of report.events) {
    if (ev.type === "stage.completed" && ev.stage && !executedStages.includes(ev.stage)) {
      executedStages.push(ev.stage);
    }

    if (ev.type === "compound.expanded" && ev.tokens) {
      for (const t of ev.tokens) {
        const exp = tokenMap.get(t.index);
        if (exp) {
          exp.compoundExpanded = true;
          exp.expansionInfo = ev.metadata?.expansion || null;
        }
      }
    }

    if (ev.type === "dictionary.match" && ev.tokens) {
      for (const t of ev.tokens) {
        const exp = tokenMap.get(t.index);
        if (exp) exp.dictionaryMatch = ev.metadata || null;
      }
    }

    if (ev.type === "dictionary.miss" && ev.tokens) {
      for (const t of ev.tokens) {
        const exp = tokenMap.get(t.index);
        if (exp) exp.dictionaryMiss = true;
      }
    }

    if (ev.type === "token.dropped" && ev.tokens) {
      for (const t of ev.tokens) {
        const exp = tokenMap.get(t.index);
        if (exp) {
          if (ev.stage === "compact") {
            exp.isNoiseRemoved = true;
          } else {
            exp.droppedReason = ev.explanation || ev.metadata?.rule || "Dropped by ambiguity rule";
            exp.claimedRule = ev.metadata?.rule || "R_DROP";
          }
        }
      }
    }

    if (ev.type === "token.reclassified" && ev.tokens) {
      for (const t of ev.tokens) {
        const exp = tokenMap.get(t.index);
        if (exp) {
          exp.reclassifiedInfo = ev.metadata || null;
          exp.claimedRule = ev.metadata?.rule || "R_RECLASSIFY";
        }
      }
    }

    if (ev.type === "token.unresolved" && ev.tokens) {
      for (const t of ev.tokens) {
        const exp = tokenMap.get(t.index);
        if (exp) exp.isUnresolved = true;
      }
    }

    if (ev.tokens) {
      for (const t of ev.tokens) {
        const exp = tokenMap.get(t.index);
        if (exp) {
          if (ev.stage && !exp.lifecycle.includes(ev.stage)) {
            exp.lifecycle.push(ev.stage);
          }
          if (t.claimedBy && !t.claimedBy.startsWith("dict:")) {
            exp.claimedRule = t.claimedBy;
          }
        }
      }
    }
  }

  const compactEvent = report.events.find((e) => e.stage === "compact" && e.type === "trace.snapshot");
  if (compactEvent && compactEvent.tokens) {
    for (const t of compactEvent.tokens) {
      const exp = tokenMap.get(t.index);
      if (exp && t.claimedBy && t.claimedBy.endsWith(":DELETE") && !exp.isNoiseRemoved) {
        exp.isAnchor = true;
      }
    }
  }

  if (result && result.parsed_components) {
    for (const exp of tokenMap.values()) {
      const capText = cap(exp.text);
      const rawText = exp.text.toLowerCase();
      const canon = exp.dictionaryMatch?.canonical || capText;

      for (const [compKey, compVal] of Object.entries(result.parsed_components)) {
        if (!compVal) continue;
        const compStr = Array.isArray(compVal) ? compVal.join(" ") : String(compVal);
        const compLower = compStr.toLowerCase();
        if (compLower.includes(rawText) || compLower.includes(canon.toLowerCase())) {
          exp.finalComponent = `parsed_components.${compKey}`;
          break;
        }
      }
    }
  }

  for (const exp of tokenMap.values()) {
    if (exp.isUnresolved) exp.status = "unresolved";
    else if (exp.droppedReason) exp.status = "dropped";
    else if (exp.reclassifiedInfo) exp.status = "reclassified";
    else if (exp.isNoiseRemoved) exp.status = "noise_removed";
    else if (exp.isAnchor) exp.status = "anchor";
    else if (exp.dictionaryMatch || exp.claimedRule) exp.status = "matched";
    else exp.status = "unresolved";
  }

  return Array.from(tokenMap.values()).sort((a, b) => a.index - b.index);
}

// Category/action vocabulary the userscript's "Add to dictionary" panel
// offered — reused by the Dictionary Manager so the dashboard supports the
// same set, per the build prompt.
export const DICTIONARY_CATEGORIES = [
  "CLASS", "OCCUPANCY", "TYPE", "BEDDING_TYPE",
  "VIEW_MODIFIER", "VIEW_MODIFIER_POSITIONAL", "VIEW_CORE",
  "BUILDING", "AMENITY", "PRIVILEGE", "NOISE",
];
export const DICTIONARY_ACTIONS = ["REPLACE", "DELETE", "EXPAND"];
