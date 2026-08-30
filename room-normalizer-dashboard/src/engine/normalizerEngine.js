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

// ENGINE EXTENSION — Access category support. The Access pre-pass (see
// pass0Access) needs to know, at raw-token level and BEFORE dictionary
// matching runs, which words belong to some other unrelated structural
// category (so it knows where to stop capturing) and which words are
// accessibility signals (so it never misreads "wheelchair access" as a
// generic Access phrase instead of leaving it for the Accessibility logic).
const DYNAMIC_ACCESS_BOUNDARY = new Set(); // CLASS/OCCUPANCY/TYPE/BUILDING/BEDDING_TYPE/NOISE vocabulary
const DYNAMIC_ACCESSIBILITY_WORDS = new Set(); // any word belonging to an ACCESSIBILITY-bucket row
const DYNAMIC_ACCESS_MODIFIER = new Set(); // e.g. "limited"
const DYNAMIC_ACCESS_ADJECTIVES = new Set(); // CLASS-category words, used to extend a resolved Access phrase backward

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
  DYNAMIC_ACCESS_BOUNDARY.clear();
  DYNAMIC_ACCESSIBILITY_WORDS.clear();
  DYNAMIC_ACCESS_MODIFIER.clear();
  DYNAMIC_ACCESS_ADJECTIVES.clear();

  for (const row of rows) {
    for (const rawSyn of row.synonyms.split(",")) {
      const syn = rawSyn.trim().toLowerCase().replace(/\s+/g, " ");
      if (!syn) continue;

      if (row.action === "EXPAND") {
        EXPANSIONS.set(syn, (row.canonical_term || "").toLowerCase());
        continue;
      }

      lookup.set(syn, {
        termId: row.id,
        canonical: row.canonical_term,
        category: row.category,
        action: row.action,
        outputBucket: row.output_bucket || null,
        triggerBucket: row.trigger_bucket || null,
        accessibilityType: row.accessibility_type || null,
      });
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

      // ENGINE EXTENSION — Access pre-pass vocab. TYPE/OCCUPANCY/BUILDING/
      // BEDDING_TYPE (genuine structural nouns) and NOISE (connectors) act
      // as stop-boundaries for the generic "<words> access" capture.
      // CLASS is deliberately NOT a boundary: it's an adjective, and an
      // adjective attaches to whatever noun it's directly touching — if
      // nothing structural separates a CLASS word from the access noun
      // ("executive lounge access"), it modifies the access noun, not the
      // Room ("Deluxe Room" still works fine, since "Room" — a TYPE word —
      // sits between "Deluxe" and any access phrase and stops the walk
      // there). Every ACCESSIBILITY-bucket word is a separate exclusion so
      // accessibility phrases stay untouched; ACCESS_MODIFIER words (e.g.
      // "limited") layer onto whatever's captured.
      if (["OCCUPANCY", "TYPE", "BUILDING", "BEDDING_TYPE", "NOISE"].includes(row.category)) {
        DYNAMIC_ACCESS_BOUNDARY.add(syn);
        for (const w of syn.split(" ")) DYNAMIC_ACCESS_BOUNDARY.add(w);
      }
      if (row.category === "CLASS") {
        DYNAMIC_ACCESS_ADJECTIVES.add(syn);
        for (const w of syn.split(" ")) DYNAMIC_ACCESS_ADJECTIVES.add(w);
      }
      if (row.output_bucket === "ACCESSIBILITY") {
        DYNAMIC_ACCESSIBILITY_WORDS.add(syn);
        for (const w of syn.split(" ")) DYNAMIC_ACCESSIBILITY_WORDS.add(w);
      }
      if (row.category === "ACCESS_MODIFIER") {
        DYNAMIC_ACCESS_MODIFIER.add(syn);
        for (const w of syn.split(" ")) DYNAMIC_ACCESS_MODIFIER.add(w);
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

// ------------------------------------------------------------
// ENGINE EXTENSIONS (dashboard-only, not yet ported to the userscript) —
// these four helpers are new parsing rules added after reviewing real
// mistranslation samples, not part of the original v1.8.0 port. Each is
// documented at its point of use below. Once validated here they need to
// be mirrored into room-normalizer-panel.user.js or the two engines will
// silently diverge.
// ------------------------------------------------------------

// "king/twin" -> "king or twin" so the alternative-preservation pass (below)
// can treat slash and the word "or" identically. Only fires when there's a
// real word/number on BOTH sides, so "w/" (NOISE synonym for "with", no
// trailing word) is left untouched.
function preprocessSlashAlternatives(sanitized) {
  return sanitized.replace(/\b([a-z0-9]+)\/([a-z0-9]+)\b/g, "$1 or $2");
}

// "2queen" -> "2 queen". A digit welded directly onto a word never gets
// separated by whitespace-based tokenization otherwise.
function splitFusedNumberWord(word) {
  const m = /^(\d+)([a-z]{2,})$/.exec(word);
  return m ? `${m[1]} ${m[2]}` : null;
}

// Drops a leading "N x" / room-quantity prefix (e.g. "1 x Residence
// Panorama Room") — refers to how many of the room are being sold, not to
// bedding count, and has no dictionary meaning.
function stripQuantityPrefix(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (/^\d+$/.test(words[i]) && words[i + 1] === "x") {
      i++; // skip both the number and the "x"
      continue;
    }
    out.push(words[i]);
  }
  return out;
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
    const numSplit = splitFusedNumberWord(w);
    if (numSplit) {
      diag?.emit("expandCompounds", "compound.expanded", [{ idx, text: w, claimedBy: null, resolved: null }], "A digit fused directly onto a word was split apart.", { expansion: numSplit, source: "fused_number" });
      out.push(numSplit);
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
  const withAlternatives = preprocessSlashAlternatives(sanitized);
  const expanded = expandCompounds(withAlternatives, dict, diag);
  const words = stripQuantityPrefix(expanded.split(" ").filter(Boolean));
  const tokens = words.map((text, idx) => ({ text, idx, claimedBy: null, resolved: null }));
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

// ENGINE EXTENSION — Access category. Unlike every other structural pass,
// this one runs BEFORE dictionary matching (pass1), because it needs to
// reclaim words the dictionary would otherwise grab for an unrelated
// category (e.g. "pool" -> VIEW_CORE) whenever those words sit directly
// next to the literal anchor word "access". Two directions are supported:
// suffix ("pool access") and prefix with a connector ("access to the
// pool").
//
// STEP 1 — an already-registered multi-word dictionary phrase touching
// "access" always wins (checked longest-first), so known synonyms like
// "club lounge access" (-> Club Access) or "roll in shower access" (->
// Roll In Shower, OTHER bucket) resolve exactly as the dictionary says,
// instead of being decomposed by the generic capture below. Without this
// step, "club lounge access" would incorrectly split into a CLASS "Club"
// (since "club" is separately CLASS vocabulary) plus a generic "Lounge
// Access" — losing the compound-privilege reading entirely.
//
// STEP 2 — generic fallback for anything NOT already registered. Capture
// is boundary-based, not word-capped — it walks outward from "access"
// until it hits a word that's genuine vocabulary for some other
// structural category (CLASS/OCCUPANCY/TYPE/BUILDING/BEDDING_TYPE) or a
// NOISE connector, or the start/end of the name. A word immediately
// touching "access" that's itself an ACCESSIBILITY signal (mobility,
// wheelchair, hearing, visual, accessible) aborts the match for that
// occurrence entirely, leaving it for the normal Accessibility dictionary
// logic. A bare "access" with nothing capturable on either side is left
// alone (falls through to the existing NOISE:DELETE dictionary rule).
const ACCESS_ARTICLES = new Set(["the", "a", "an"]);

function pass0Access(tokens, dict, diag, telemetry) {
  const n = tokens.length;
  for (let i = 0; i < n; i++) {
    const t = tokens[i];
    if (t.claimedBy !== null || t.text !== "access") continue;

    let coreStart = null, coreEnd = null, dictMatch = null;

    // STEP 1 — exact dictionary phrase, longest match first, tried in
    // both directions (a phrase can end at "access" or start at it).
    outer:
    for (let len = dict.maxPhraseLen; len >= 2; len--) {
      const suffixStart = i - len + 1;
      if (suffixStart >= 0) {
        const window = tokens.slice(suffixStart, i + 1);
        if (window.every((tok) => tok.claimedBy === null)) {
          const match = dict.lookup.get(window.map((tok) => tok.text).join(" "));
          if (match) { coreStart = suffixStart; coreEnd = i + 1; dictMatch = match; break outer; }
        }
      }
      const prefixEnd = i + len;
      if (prefixEnd <= n) {
        const window = tokens.slice(i, prefixEnd);
        if (window.every((tok) => tok.claimedBy === null)) {
          const match = dict.lookup.get(window.map((tok) => tok.text).join(" "));
          if (match) { coreStart = i; coreEnd = prefixEnd; dictMatch = match; break outer; }
        }
      }
    }

    // STEP 2 — generic boundary-based capture, only if nothing registered
    // matched. A leading article right after "to" is skipped (claimed but
    // not part of the captured noun phrase) so "access to the pool" reads
    // the same as "access to pool".
    let genericPhrase = null;
    if (!dictMatch) {
      const suffixWords = [];
      let j = i - 1;
      while (j >= 0 && tokens[j].claimedBy === null && !DYNAMIC_ACCESS_BOUNDARY.has(tokens[j].text)) {
        suffixWords.unshift(tokens[j].text);
        j--;
      }
      let prefixWords = [];
      let prefixEnd = i + 1;
      if (suffixWords.length === 0 && i + 1 < n && tokens[i + 1].claimedBy === null && tokens[i + 1].text === "to") {
        let k = i + 2;
        if (k < n && tokens[k].claimedBy === null && ACCESS_ARTICLES.has(tokens[k].text)) k++;
        while (k < n && tokens[k].claimedBy === null && !DYNAMIC_ACCESS_BOUNDARY.has(tokens[k].text)) {
          prefixWords.push(tokens[k].text);
          k++;
        }
        prefixEnd = k;
      }
      const words = suffixWords.length > 0 ? suffixWords : prefixWords;
      if (words.length === 0) continue; // bare "access" — leave for NOISE:DELETE
      if (words.some((w) => DYNAMIC_ACCESSIBILITY_WORDS.has(w))) continue; // exclusion

      genericPhrase = words.map(cap).join(" ") + " Access";
      coreStart = suffixWords.length > 0 ? i - suffixWords.length : i;
      coreEnd = suffixWords.length > 0 ? i + 1 : prefixEnd;
    }

    // Adjective extension — a CLASS word (adjective) sitting directly
    // before the resolved core, with no structural noun in between,
    // describes the access privilege itself ("executive" in "executive
    // lounge access"), not the Room. This applies uniformly whether the
    // core came from an exact dictionary phrase (STEP 1) or generic
    // capture (STEP 2) — for STEP 2 this is normally a no-op, since CLASS
    // isn't a boundary there and the walk already swept adjacent
    // adjectives in on its own; it's STEP 1 that needs this, because a
    // matched dictionary window is fixed-length and won't otherwise grow
    // to absorb a CLASS word sitting just outside it (e.g. "lounge access"
    // matching before "executive" is ever considered).
    const adjectiveWords = [];
    let adjIdx = coreStart - 1;
    while (adjIdx >= 0 && tokens[adjIdx].claimedBy === null && DYNAMIC_ACCESS_ADJECTIVES.has(tokens[adjIdx].text)) {
      adjectiveWords.unshift(tokens[adjIdx].text);
      adjIdx--;
    }
    if (adjectiveWords.length > 0) {
      const prefix = `${adjectiveWords.map(cap).join(" ")} `;
      if (dictMatch) dictMatch = { ...dictMatch, canonical: prefix + (dictMatch.canonical || "") };
      else genericPhrase = prefix + genericPhrase;
      coreStart = adjIdx + 1;
    }

    // Modifier check applies uniformly to BOTH paths above — a preceding
    // ACCESS_MODIFIER word (e.g. "limited") extends the claim and prepends
    // "Limited " regardless of whether the core noun resolved via an exact
    // dictionary phrase or the generic capture. This has to happen after
    // core resolution, not during it, or a noun that happens to already be
    // a registered dictionary bigram (e.g. "lounge access") would resolve
    // via STEP 1 before the modifier check ever ran, silently dropping
    // "limited".
    let claimStart = coreStart;
    const hasModifier = coreStart - 1 >= 0 && tokens[coreStart - 1].claimedBy === null && DYNAMIC_ACCESS_MODIFIER.has(tokens[coreStart - 1].text);
    if (hasModifier) claimStart = coreStart - 1;

    if (dictMatch) {
      applyDictionaryMatch(tokens, coreStart, coreEnd, dictMatch, telemetry, diag, "pass0_access_dict");
      if (hasModifier && dictMatch.action !== "DELETE") {
        const merged = { ...dictMatch, canonical: `Limited ${dictMatch.canonical || ""}`.trim() };
        claim(tokens, claimStart, coreStart, "dict:ACCESS_MODIFIER:REPLACE");
        for (let idx = claimStart; idx < coreEnd; idx++) tokens[idx].resolved = merged;
      }
    } else {
      const finalPhrase = hasModifier ? `Limited ${genericPhrase}` : genericPhrase;
      claim(tokens, claimStart, coreEnd, "dict:ACCESS:REPLACE");
      const resolved = { canonical: finalPhrase, category: "ACCESS", action: "REPLACE", outputBucket: null, triggerBucket: null, accessibilityType: null };
      for (let idx = claimStart; idx < coreEnd; idx++) tokens[idx].resolved = resolved;
    }
    telemetry?.ruleHit("ENGINE:R_ACCESS_GENERIC");
    diag?.emit("pass0_access", "access.detected", tokens.slice(claimStart, coreEnd), "Detected an access phrase.", { viaDictionary: !!dictMatch });
  }
}

// Applies one resolved dictionary match to a token window — shared by
// pass1's normal phrase matching and by pass0Access's dictionary-priority
// check (see below), so both behave identically for DELETE vs REPLACE and
// the single-token-vs-multi-token text mutation.
function applyDictionaryMatch(tokens, start, end, match, telemetry, diag, stage) {
  const window = tokens.slice(start, end);
  const phrase = window.map((t) => t.text).join(" ");
  const { termId, canonical, category, action, outputBucket, triggerBucket, accessibilityType } = match;
  telemetry?.ruleHit(`DICT:${termId || `${category}:${phrase}`}`, termId || null);
  if (action === "DELETE") {
    claim(tokens, start, end, `dict:${category}:DELETE`);
    diag?.emit(stage, "dictionary.match", window, "A dictionary DELETE rule claimed these tokens.", { termId, phrase, canonical, category, action });
    return;
  }
  if (window.length === 1) {
    window[0].text = canonical ? canonical.toLowerCase() : window[0].text;
    window[0].resolved = { termId, canonical, category, action, outputBucket, triggerBucket, accessibilityType };
  } else {
    claim(tokens, start, end, `dict:${category}:REPLACE`);
    window.forEach((t) => (t.resolved = { termId, canonical, category, action, outputBucket, triggerBucket, accessibilityType }));
  }
  diag?.emit(stage, "dictionary.match", window, "A dictionary entry resolved these tokens.", { termId, phrase, canonical, category, action });
}

function pass1(tokens, dict, diag, telemetry) {
  for (const { start, end, window } of unclaimedWindows(tokens, dict.maxPhraseLen)) {
    const phrase = window.map((t) => t.text).join(" ");
    const match = dict.lookup.get(phrase);
    if (!match) continue;
    applyDictionaryMatch(tokens, start, end, match, telemetry, diag, "pass1_dictionary");
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
    if (isAmbiguous && !hasNum && !hasAnchor) {
      // ENGINE EXTENSION — bare unqualified "twin" (no number, no anchor)
      // defaults to "2 Single Beds" per explicit product decision. "double"
      // and "single" are unchanged and still fall through to
      // pass2DropAmbiguous below (genuinely ambiguous without context).
      if (canonType === "twin") {
        claim(tokens, start, end, "R_BED");
        return "2 Single Beds";
      }
      continue;
    }

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

// ------------------------------------------------------------
// ENGINE EXTENSION — preserves an explicit "X or Y" (including "X/Y", via
// preprocessSlashAlternatives above) literally, rather than guessing which
// one applies or silently merging them. This is the supplier's own stated
// ambiguity, not the engine's — normalize accurately, don't decide for them.
// Same word repeated ("queen or queen", from "queen/queen") means 2 of that
// type instead of a real alternative.
// ------------------------------------------------------------
function categoryOf(t) {
  if (isBedTypeToken(t)) return "BEDDING_TYPE";
  if (isViewCore(t)) return "VIEW_CORE";
  if (t.resolved?.category === "AMENITY" || t.resolved?.category === "PRIVILEGE") return "AMENITY";
  return null;
}

function pass2AlternativeSingle(tokens) {
  for (const { start, end, window } of patternWindows(tokens, 3)) {
    if (window.length !== 3) continue;
    const [a, orTok, b] = window;
    if (orTok.text !== "or") continue;
    const catA = categoryOf(a);
    const catB = categoryOf(b);
    if (!catA || catA !== catB) continue;

    const canonA = a.resolved?.canonical || cap(a.text);
    const canonB = b.resolved?.canonical || cap(b.text);
    claim(tokens, start, end, "R_ALTERNATIVE");

    // ENGINE EXTENSION — accessibility rows carry a sub-type (MOBILITY/
    // HEARING/VISUAL) instead of freestanding output text, so an "X or Y"
    // alternative between two accessibility terms combines both sub-types
    // rather than producing literal "X or Y" text.
    const accessibilityTypes = [a.resolved?.accessibilityType, b.resolved?.accessibilityType].filter(Boolean);

    if (canonA === canonB) {
      if (catA === "BEDDING_TYPE") return { category: catA, text: `2 ${canonA} Beds`, outputBucket: a.resolved?.outputBucket, accessibilityTypes };
      if (catA === "VIEW_CORE") return { category: catA, text: `${canonA} View`, outputBucket: a.resolved?.outputBucket, accessibilityTypes };
      return { category: catA, text: canonA, outputBucket: a.resolved?.outputBucket, accessibilityTypes };
    }
    if (catA === "VIEW_CORE") return { category: catA, text: `${canonA} or ${canonB} View`, outputBucket: a.resolved?.outputBucket, accessibilityTypes };
    return { category: catA, text: `${canonA} or ${canonB}`, outputBucket: a.resolved?.outputBucket, accessibilityTypes };
  }
  return null;
}

function pass2AlternativeAll(tokens) {
  const results = [];
  let match;
  while ((match = pass2AlternativeSingle(tokens)) !== null) results.push(match);
  return results;
}

// ------------------------------------------------------------
// ENGINE EXTENSION — "twin" immediately followed by another recognized
// bedding noun (futon, bunk) is a SIZE MODIFIER on that noun, not a bed-
// count indicator — "4 Twin Futons beds" means 4 futon beds, not "4 twin
// beds" plus a stray "Futons". Scoped to twin only (not king/queen), per
// explicit product decision — those haven't shown this confusion.
// ------------------------------------------------------------
const TWIN_MODIFIER_TARGETS = new Set(["futon", "bunk"]);

function pass2TwinModifier(tokens) {
  for (const { start, end, window } of patternWindows(tokens, 3)) {
    if (window.length !== 3) continue;
    const [a, b, c] = window;
    const n = parseNumber(a.text);
    if (n === null) continue;
    if ((b.resolved?.canonical || b.text).toLowerCase() !== "twin") continue;
    const cCanon = (c.resolved?.canonical || c.text).toLowerCase();
    if (!TWIN_MODIFIER_TARGETS.has(cCanon)) continue;
    claim(tokens, start, end, "R_TWIN_MODIFIER");
    return `${n} ${cap(cCanon)} ${n === 1 ? "Bed" : "Beds"}`;
  }
  for (const { start, end, window } of patternWindows(tokens, 2)) {
    if (window.length !== 2) continue;
    const [a, b] = window;
    if ((a.resolved?.canonical || a.text).toLowerCase() !== "twin") continue;
    const bCanon = (b.resolved?.canonical || b.text).toLowerCase();
    if (!TWIN_MODIFIER_TARGETS.has(bCanon)) continue;
    claim(tokens, start, end, "R_TWIN_MODIFIER");
    return `1 ${cap(bCanon)} Bed`;
  }
  return null;
}

// ------------------------------------------------------------
// ENGINE EXTENSION — flags a genuine, narrow conflict rather than silently
// picking one: NUMBER + TYPE1 + TYPE2 + BED_ANCHOR with two DIFFERENT bed
// types both sitting between the same number and the same anchor (e.g.
// "1 double king bed" — is it a double, or a king?). Deliberately narrow:
// requires the full 4-token shape so it does NOT fire on cases the engine
// already handles correctly, like "queen double" (ambiguous type correctly
// drops via pass2DropAmbiguous) or "1 double bed 2 twin beds" (two genuinely
// separate, independently-anchored bed groups).
// ------------------------------------------------------------
function detectConflictingBedding(tokens, telemetry, diag) {
  for (const { start, end, window } of patternWindows(tokens, 4)) {
    if (window.length !== 4) continue;
    const [numTok, t1, t2, anchorTok] = window;
    if (parseNumber(numTok.text) === null) continue;
    if (!isBedTypeToken(t1) || !isBedTypeToken(t2)) continue;
    if (!BED_ANCHOR.has(anchorTok.text)) continue;
    const canon1 = (t1.resolved?.canonical || t1.text).toLowerCase();
    const canon2 = (t2.resolved?.canonical || t2.text).toLowerCase();
    if (canon1 === canon2) continue;
    claim(tokens, start, end, "R_CONFLICTING_BEDDING");
    const label1 = t1.resolved?.canonical || cap(t1.text);
    const label2 = t2.resolved?.canonical || cap(t2.text);
    telemetry?.review({
      kind: "CONFLICTING_BEDDING",
      code: "ADJACENT_BEDDING_CONFLICT",
      token: `${t1.text} ${t2.text}`,
      phase: "pass2",
      explanation: `"${label1}" and "${label2}" both sit between the same number and bed anchor with nothing distinguishing which one applies \u2014 needs a human decision.`,
    });
    diag?.emit("detectConflictingBedding", "token.dropped", [t1, t2], `Conflicting adjacent bedding types: ${label1} vs ${label2}.`, { rule: "R_CONFLICTING_BEDDING", candidates: [label1, label2] });
    return { candidates: [label1, label2] };
  }
  return null;
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
  // ENGINE EXTENSION — output-bucket layer. `class`/`occupancy`/`type`/
  // `building` still come from structural category as before. AMENITY /
  // PRIVILEGE / CONDITIONAL / NOISE no longer map to a single fixed bucket —
  // each dictionary row says where it lands via `output_bucket`
  // (ACCESSIBILITY / OTHER / NOT_NEEDED, dropped) or, for CONDITIONAL rows
  // whose job is to blank another bucket instead of showing their own text,
  // via `trigger_bucket` (ROOM / BEDDING), collected into `triggers` for
  // assemble() to apply.
  const buckets = { class: [], occupancy: [], type: [], building: [], accessibilityTypes: [], access: [], other: [], undefined: [], triggers: [] };

  // ENGINE EXTENSION — consecutive unresolved tokens get grouped into ONE
  // review event with the combined phrase, instead of one event per word
  // (previously "subject to availability" logged as three separate rows:
  // "subject", "to", "availability"). Applies generally, not just to
  // conditional phrases — helps every future multi-word dictionary gap.
  let unresolvedRun = [];
  function flushUnresolvedRun() {
    if (unresolvedRun.length === 0) return;
    const phrase = unresolvedRun.map((t) => t.text).join(" ");
    telemetry?.review({
      kind: "UNRESOLVED",
      code: "NO_DICTIONARY_MATCH",
      token: phrase,
      phase: "pass3",
      explanation: unresolvedRun.length > 1
        ? "No dictionary entry or structural rule recognized this phrase."
        : "No dictionary entry or structural rule recognized this token.",
    });
    unresolvedRun = [];
  }

  for (const t of tokens) {
    if (t.claimedBy !== null && !t.claimedBy.startsWith("dict:")) { flushUnresolvedRun(); continue; }
    if (t.claimedBy !== null && t.claimedBy.endsWith(":DELETE")) { flushUnresolvedRun(); continue; }
    if (t.resolved) {
      flushUnresolvedRun();
      const { canonical, category, outputBucket, triggerBucket, accessibilityType } = t.resolved;
      if (category === "CLASS") buckets.class.push(canonical);
      else if (category === "OCCUPANCY") buckets.occupancy.push(canonical);
      else if (category === "TYPE") buckets.type.push(canonical);
      else if (category === "BUILDING") buckets.building.push(canonical);
      else if (category === "ACCESS") {
        // ENGINE EXTENSION — synthetic match from pass0Access (the generic
        // "<words> access" detector), not a real dictionary row.
        buckets.access.push(canonical);
      }
      else if (category === "AMENITY" || category === "PRIVILEGE" || category === "CONDITIONAL" || category === "NOISE") {
        // Trigger-only rows (Run Of House, Assigned On Arrival, Shared
        // Accommodation, Bed Subject To Availability) don't show their own
        // text — they just flag a bucket to render as "not specified".
        if (triggerBucket) {
          buckets.triggers.push(triggerBucket);
        } else if (outputBucket === "ACCESSIBILITY") {
          // ENGINE EXTENSION — accessibility rows carry a sub-type
          // (MOBILITY/HEARING/VISUAL) rather than their own output text;
          // the sub-types collected here get resolved into one of the 4
          // canonical accessibility phrases in assemble().
          if (accessibilityType) buckets.accessibilityTypes.push(accessibilityType);
        } else if (outputBucket === "ACCESS") {
          // ENGINE EXTENSION — dictionary-driven Access synonyms that don't
          // literally contain the word "access" (e.g. "club benefits",
          // "club privileges") and so can't be caught by pass0Access.
          buckets.access.push(canonical);
        } else if (outputBucket === "OTHER") {
          buckets.other.push(canonical);
        }
        // outputBucket === "NOT_NEEDED" (or unset, e.g. NOISE rows that were
        // never given one) → dropped, contributes nothing to output.
      }
      else if (category === "VIEW_CORE" || category === "VIEW_MODIFIER" || category === "VIEW_MODIFIER_POSITIONAL") {
        if (canonical) {
          buckets.undefined.push(canonical);
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
          buckets.undefined.push(canonical);
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
    // ENGINE EXTENSION — an orphaned bare number/word-number that never got
    // consumed by a structural rule (e.g. "Two" in "APARTMENT TWO BEDS")
    // gets dropped instead of leaking a meaningless stray number into output.
    const isOrphanNumber = parseNumber(t.text) !== null;
    if (!isOrphanNumber) {
      buckets.undefined.push(cap(t.text));
    }
    if (auditSink) auditSink(t.text, rawName);
    unresolvedRun.push(t);
    diag?.emit(
      "pass3",
      "token.unresolved",
      [t],
      isOrphanNumber
        ? "An orphaned number with no adjacent recognized type was dropped rather than shown as stray text."
        : "No dictionary or structural rule resolved this token, so it was emitted as undefined output.",
      { bucket: isOrphanNumber ? null : "undefined" }
    );
  }
  flushUnresolvedRun();
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

const ROOM_NOT_SPECIFIED = "(Non Specified Room)";
const BED_NOT_SPECIFIED = "(Bed Not Specified)";

// ENGINE EXTENSION — the Accessible category resolves to exactly one of
// 4 fixed phrases, built from whichever sub-types (MOBILITY/HEARING/VISUAL)
// were detected. Mobility is always the base; Hearing/Visual are additive
// qualifiers layered in front of it — never a replacement for it.
function resolveAccessibilityPhrase(accessibilityTypes) {
  const types = new Set(accessibilityTypes);
  if (types.size === 0) return null;
  const hasHearing = types.has("HEARING");
  const hasVisual = types.has("VISUAL");
  if (hasHearing && hasVisual) return "Hearing Visual Mobility Access";
  if (hasHearing) return "Hearing Mobility Access";
  if (hasVisual) return "Visual Mobility Access";
  return "Mobility Access";
}

async function assemble(buckets, bedroom, beddingList, viewList) {
  let classList = dedup(buckets.class);
  if (classList.length === 0) classList = ["Standard"];

  const occupancyList = dedup(buckets.occupancy);

  let typeList = dedup(buckets.type);
  if (typeList.length === 0) typeList = ["Room"];

  const buildingList = dedup(buckets.building);
  const accessibilityPhrase = resolveAccessibilityPhrase(buckets.accessibilityTypes);
  const accessList = dedup(buckets.access);
  const otherList = dedup(buckets.other);
  const undefinedList = dedup(buckets.undefined);
  const triggers = new Set(buckets.triggers || []);

  const beddingClean = dedup(beddingList || []);
  const viewClean = dedup(viewList || []);
  let beddingLine = beddingClean.length ? beddingClean.join(", ") : null;
  const viewLine = viewClean.length ? viewClean.join(", ") : null;

  // ENGINE EXTENSION — the core room-type phrase (class + occupancy + type +
  // bedroom) stays space-joined so it reads as one phrase ("Deluxe King
  // Room"). Every other category becomes its own comma-separated segment in
  // the final string, so distinct categories are visually separated instead
  // of running together as one long space-joined blob.
  const coreParts = [...classList];
  if (occupancyList.length) coreParts.push(...occupancyList);
  // ENGINE EXTENSION — Accessible is woven into the core Room phrase, right
  // before Type, rather than rendered as its own comma segment ("Deluxe
  // King Hearing Mobility Access Room", not "Deluxe King Room, Hearing
  // Mobility Access").
  if (accessibilityPhrase) coreParts.push(accessibilityPhrase);
  coreParts.push(...typeList);
  if (bedroom) coreParts.push(bedroom);
  let coreLine = coreParts.join(" ");

  // ENGINE EXTENSION — trigger-only dictionary rows (Run Of House, Assigned
  // On Arrival, Shared Accommodation, Bed Subject To Availability) don't add
  // their own text; they replace an entire bucket's computed value with a
  // "not specified" placeholder, since the raw name is explicitly saying
  // that detail isn't known yet rather than giving the engine something
  // wrong to guess at.
  if (triggers.has("ROOM")) coreLine = ROOM_NOT_SPECIFIED;
  if (triggers.has("BEDDING")) beddingLine = BED_NOT_SPECIFIED;

  const segments = [coreLine];
  if (beddingLine) segments.push(beddingLine);
  if (viewLine) segments.push(viewLine);
  if (buildingList.length) segments.push(buildingList.join(", "));
  if (accessList.length) segments.push(accessList.join(", "));
  if (otherList.length) segments.push(otherList.join(", "));
  // ENGINE EXTENSION — `undefined` (genuinely unresolved leftover text) no
  // longer renders into canonical_string. Every one of the 8 output buckets
  // is defined-by-construction; undefined text has no bucket to sit in, so
  // it stays out of the visible output and only lives in parsed_components
  // + the UNRESOLVED review-queue flag (already emitted above) until a
  // dictionary row or an AI classification gives it a real home.

  const canonical_string = segments.filter(Boolean).join(", ");
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
      accessibility: accessibilityPhrase,
      access: accessList.length ? accessList : null,
      other: otherList.length ? otherList : null,
      undefined: undefinedList,
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

  // ENGINE EXTENSION — Access detection must run before dictionary matching
  // so it can reclaim words (e.g. "pool") that pass1 would otherwise grab
  // for an unrelated category. See pass0Access for the full rationale.
  pass0Access(tokens, dict, diag, telemetry);
  diag.snapshot("pass0_access", tokens);
  telemetry.stage("pass0_access", tokens);

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

  // ENGINE EXTENSION — explicit "or"/"/" alternatives take priority over
  // every other bedding/view/amenity interpretation, since they're the
  // supplier's own stated ambiguity, not the engine's to resolve.
  const alternatives = pass2AlternativeAll(tokens);
  diag.emit("pass2AlternativeAll", "stage.completed", tokens, "Explicit alternative ('or'/'/') pass completed.", { output: alternatives });
  for (const alt of alternatives) telemetry.ruleHit(`ENGINE:R_ALTERNATIVE_${alt.category}`);
  const altBedding = alternatives.filter((a) => a.category === "BEDDING_TYPE").map((a) => a.text);
  const altView = alternatives.filter((a) => a.category === "VIEW_CORE").map((a) => a.text);
  const altAmenity = alternatives.filter((a) => a.category === "AMENITY");

  const twin = pass2TwinSpecial(tokens);
  diag.emit("pass2TwinSpecial", "stage.completed", tokens, "Twin-specific pattern pass completed.", { bedding: twin.bedding, extraType: twin.extraType });
  if (twin.bedding || twin.extraType) telemetry.ruleHit(`ENGINE:${twin.extraType ? "TWIN_ROOM" : "TWIN_BED"}`);

  // ENGINE EXTENSION — "twin" as a size modifier on futon/bunk, not a count.
  const twinModifierBedding = pass2TwinModifier(tokens);
  diag.emit("pass2TwinModifier", "stage.completed", tokens, "Twin-as-modifier pass completed.", { output: twinModifierBedding });
  if (twinModifierBedding) telemetry.ruleHit("ENGINE:R_TWIN_MODIFIER");

  // ENGINE EXTENSION — flag genuinely conflicting adjacent bedding types
  // instead of silently picking one.
  const conflict = detectConflictingBedding(tokens, telemetry, diag);

  const beddingList = [
    ...altBedding,
    ...(twin.bedding ? [twin.bedding] : []),
    ...(twinModifierBedding ? [twinModifierBedding] : []),
    ...(conflict ? [`${conflict.candidates.join(" or ")} (unclear)`] : []),
    ...pass2BeddingAll(tokens),
  ];
  diag.emit("pass2BeddingAll", "stage.completed", tokens, "Bedding pattern pass completed.", { output: beddingList });
  const genericBedCount = beddingList.length - altBedding.length - (twin.bedding ? 1 : 0) - (twinModifierBedding ? 1 : 0) - (conflict ? 1 : 0);
  for (let i = 0; i < Math.max(0, genericBedCount); i++) telemetry.ruleHit("ENGINE:R_BED");

  const viewList = [...altView, ...pass2ViewAll(tokens)];
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
  // ENGINE EXTENSION — "or" alternatives between two AMENITY terms route the
  // same way a single dictionary match would: by output_bucket, not a fixed
  // bucket. (This path bypasses pass3, so it needs the same routing done
  // explicitly here.)
  for (const alt of altAmenity) {
    if (alt.outputBucket === "ACCESSIBILITY") buckets.accessibilityTypes.push(...(alt.accessibilityTypes || []));
    else if (alt.outputBucket === "OTHER") buckets.other.push(alt.text);
  }
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
  "BUILDING", "AMENITY", "PRIVILEGE", "CONDITIONAL", "NOISE", "ACCESS_MODIFIER",
];
export const DICTIONARY_ACTIONS = ["REPLACE", "DELETE", "EXPAND"];

// The 8 final output groupings a normalized name assembles into (see the
// output-bucket redesign). CLASS/OCCUPANCY/TYPE -> ROOM, BEDDING_TYPE ->
// BEDDING, VIEW_* -> VIEW, BUILDING -> BUILDING are derived from `category`
// automatically. Only rows whose category is AMENITY / PRIVILEGE /
// CONDITIONAL / NOISE need an explicit output_bucket, since those categories
// don't map 1:1 to a single output group. ACCESS is mostly populated by the
// generic pass0Access detector rather than by dictionary rows — only
// non-"access"-worded synonyms (e.g. "club benefits") need an explicit row.
export const OUTPUT_BUCKETS = ["ROOM", "BEDROOM", "BEDDING", "VIEW", "BUILDING", "ACCESSIBILITY", "ACCESS", "OTHER", "NOT_NEEDED"];
// Rows whose category is CONDITIONAL can instead (or additionally) blank a
// bucket into a placeholder rather than showing their own text.
export const TRIGGER_BUCKETS = ["ROOM", "BEDDING"];
