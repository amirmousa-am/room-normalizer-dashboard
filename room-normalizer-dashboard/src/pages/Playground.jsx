import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useDictionary } from "../engine/useDictionary";
import {
  normalizeCore,
  buildLookup,
  buildTokenExplanations,
  TOKEN_STATUS,
  createCollector,
} from "../engine/normalizerEngine";

const ISSUE_KINDS = new Set(["CONFLICTING_BEDDING", "AMBIGUOUS_DROP", "UNRESOLVED", "UNPAIRED_SEMANTIC"]);
const ISSUE_LABELS = {
  CONFLICTING_BEDDING: "Conflicting bedding",
  AMBIGUOUS_DROP: "Ambiguous — dropped",
  UNRESOLVED: "Unresolved token",
  UNPAIRED_SEMANTIC: "Recognized but unpaired",
};

const STAGE_LABELS = {
  tokenize: "Tokenize",
  pass1_dictionary: "Pass 1 — Dictionary claims",
  compact: "Compact (drop noise)",
  pass2_structural: "Pass 2 — Bedroom / Twin / Bedding / View / Occupancy",
  pass2_ambiguity: "Pass 2 — Drop ambiguous",
  pass3_buckets: "Pass 3 — Buckets",
};

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function TokenChip({ exp, selected, onClick }) {
  const cfg = TOKEN_STATUS[exp.status] || TOKEN_STATUS.unresolved;
  const colorMap = {
    matched: "border-green-800 text-green-300 bg-green-950",
    unresolved: "border-yellow-800 text-yellow-200 bg-yellow-950",
    dropped: "border-orange-800 text-orange-300 bg-orange-950",
    reclassified: "border-blue-800 text-blue-200 bg-blue-950",
    noise_removed: "border-gray-700 text-gray-400 bg-gray-900",
    anchor: "border-purple-800 text-purple-200 bg-purple-950",
  };
  const label = exp.status !== "matched" ? cfg.label : exp.dictionaryMatch?.category || "Matched";
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full border text-xs inline-flex items-center gap-1.5 transition-all ${
        colorMap[exp.status]
      } ${selected ? "ring-2 ring-sky-400 font-semibold" : "hover:brightness-125"}`}
    >
      <span>{cfg.icon}</span>
      <span>{exp.text}</span>
      <span className="opacity-70">{label}</span>
    </button>
  );
}

function TokenDetail({ exp }) {
  if (!exp) return <div className="text-base-400 text-sm">No token details available.</div>;
  const cfg = TOKEN_STATUS[exp.status] || TOKEN_STATUS.unresolved;

  let statusSubtext = "";
  if (exp.status === "matched") {
    statusSubtext = `Resolved as ${exp.dictionaryMatch?.category || exp.claimedRule || "Resolved"}`;
  } else if (exp.status === "unresolved") {
    statusSubtext = "Unresolved → emitted as Custom";
  } else if (exp.status === "dropped") {
    statusSubtext = `Dropped (${exp.droppedReason || "Ambiguity rule"})`;
  } else if (exp.status === "reclassified") {
    statusSubtext = `Reclassified as ${exp.reclassifiedInfo?.category || "OCCUPANCY"}`;
  } else if (exp.status === "noise_removed") {
    statusSubtext = "Dropped as noise in compact pass";
  } else if (exp.status === "anchor") {
    statusSubtext = "Retained as structural anchor";
  }

  const whyLines = [];
  whyLines.push("✓ Sanitized successfully");
  whyLines.push(
    exp.compoundExpanded
      ? `✓ Compound expansion applied (${exp.expansionInfo ? `“${exp.expansionInfo}”` : "expanded"})`
      : "✗ No compound expansion applied"
  );
  if (exp.dictionaryMatch) {
    whyLines.push(`✓ Dictionary matched "${exp.dictionaryMatch.phrase || exp.text}"`);
    if (exp.dictionaryMatch.termId) whyLines.push(`✓ Dictionary row: #${exp.dictionaryMatch.termId}`);
    if (exp.dictionaryMatch.canonical) whyLines.push(`✓ Canonical: ${exp.dictionaryMatch.canonical}`);
    if (exp.dictionaryMatch.category) whyLines.push(`✓ Category: ${exp.dictionaryMatch.category}`);
  } else {
    whyLines.push("✗ No dictionary row matched");
  }
  if (exp.claimedRule) {
    whyLines.push(`✓ Structural rule ${exp.claimedRule} claimed this token`);
  } else {
    whyLines.push("✗ No structural rule claimed this token");
  }
  if (exp.status === "unresolved") whyLines.push("→ Reached pass3 and was emitted as custom output");
  else if (exp.status === "matched") whyLines.push(`→ Added to the ${(exp.dictionaryMatch?.category || "parsed").toLowerCase()} component`);
  else if (exp.status === "dropped") whyLines.push(`→ Rule ${exp.claimedRule || "R_DROP"} removed the token`);
  else if (exp.status === "reclassified") whyLines.push(`→ Reclassified as ${exp.reclassifiedInfo?.category || "OCCUPANCY"}`);
  else if (exp.status === "noise_removed") whyLines.push("→ Removed during compact pass");
  else if (exp.status === "anchor") whyLines.push("→ Retained as structural anchor for pattern matching");

  const finalLoc = exp.finalComponent || (exp.status === "unresolved" ? "parsed_components.custom" : "N/A");

  return (
    <div className="bg-base-950 border border-base-800 rounded-md p-3 text-sm space-y-3">
      <div className="font-semibold text-base-50">Selected token: {exp.text}</div>
      <div>
        <div className="text-base-400 text-xs mb-1">Status</div>
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold border ${
          {
            matched: "bg-green-950 text-green-300 border-green-800",
            unresolved: "bg-yellow-950 text-yellow-200 border-yellow-800",
            dropped: "bg-orange-950 text-orange-300 border-orange-800",
            reclassified: "bg-blue-950 text-blue-200 border-blue-800",
            noise_removed: "bg-gray-900 text-gray-400 border-gray-700",
            anchor: "bg-purple-950 text-purple-200 border-purple-800",
          }[exp.status]
        }`}>
          {cfg.icon} {statusSubtext}
        </span>
      </div>
      <div>
        <div className="text-base-400 text-xs mb-1">Why?</div>
        <div className="font-mono text-xs text-base-200 space-y-0.5">
          {whyLines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
      <div>
        <div className="text-base-400 text-xs mb-1">Evidence</div>
        <div className="text-xs text-base-200 space-y-0.5">
          <div>
            <strong>Dictionary:</strong>{" "}
            {exp.dictionaryMatch
              ? `Row #${exp.dictionaryMatch.termId || "N/A"} · Canonical: ${exp.dictionaryMatch.canonical || "N/A"} · Category: ${exp.dictionaryMatch.category || "N/A"} · Action: ${exp.dictionaryMatch.action || "REPLACE"}`
              : "No match"}
          </div>
          <div><strong>Final location:</strong> {finalLoc}</div>
        </div>
      </div>
      {exp.dictionaryMatch?.termId && (
        <Link
          to={`/dictionary?term=${exp.dictionaryMatch.termId}`}
          className="inline-block text-xs text-sky-400 hover:text-sky-300 underline"
        >
          Open dictionary row #{exp.dictionaryMatch.termId} →
        </Link>
      )}
    </div>
  );
}

export default function Playground() {
  const { rows, dict, loading, error, reload } = useDictionary();
  const [raw, setRaw] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState("testing"); // "testing" | "collecting"
  const collectorRef = useRef(null);

  const [aiRunning, setAiRunning] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState({}); // token -> { error, suggestion }
  const [aiResult, setAiResult] = useState(null);

  function getCollector() {
    if (!collectorRef.current) collectorRef.current = createCollector("playground", supabase);
    return collectorRef.current;
  }

  const explanations = useMemo(() => {
    if (!result?.diagnosticsReport) return [];
    return buildTokenExplanations(result.diagnosticsReport, result);
  }, [result]);

  const selected = explanations.find((e) => e.index === selectedIndex) || explanations[0];

  const issues = useMemo(
    () => (result?.diagnostics || []).filter((d) => ISSUE_KINDS.has(d.kind)),
    [result]
  );
  const issueTokens = useMemo(() => [...new Set(issues.map((i) => i.token))], [issues]);

  async function run() {
    if (!raw.trim() || !dict) return;
    setRunning(true);
    setRunError(null);
    setStatus(null);
    setAiResult(null);
    setAiSuggestions({});
    try {
      // Rebuild from `rows` rather than trusting the cached `dict` object —
      // buildLookup() mutates module-level engine state, and a prior "Get AI
      // help" run may have left that state pointed at an ephemeral dict. This
      // guarantees a plain Normalize always reflects the real dictionary.
      const freshDict = buildLookup(rows);
      const r = await normalizeCore(raw.trim(), freshDict, { trace: true, diagnostics: true });
      setResult(r);
      const firstProblem = buildTokenExplanations(r.diagnosticsReport, r).find((e) => e.status !== "matched");
      setSelectedIndex(firstProblem ? firstProblem.index : 0);

      if (mode === "collecting") {
        const collector = getCollector();
        collector.recordResult(r);
        const eventCount = (r.diagnostics || []).length;
        try {
          await collector.flush();
          setStatus(eventCount > 0 ? `Collected ${eventCount} review event${eventCount === 1 ? "" : "s"} to the queue.` : "Nothing to collect for this case — every token resolved cleanly.");
        } catch (flushErr) {
          setStatus(`Collection failed: ${flushErr.message || flushErr}`);
        }
      }
    } catch (err) {
      setRunError(err.message || String(err));
    } finally {
      setRunning(false);
    }
  }

  // ENGINE EXTENSION — AI lives in the middle of normalization, not off to
  // the side. Each flagged token gets sent to the ai-normalize edge function
  // (server-side Gemini call, dictionary-aware). Every suggestion that comes
  // back is turned into an ordinary dictionary-row shape and handed to
  // buildLookup() alongside the real dictionary — the engine then re-runs
  // its normal pipeline against that merged lookup. There's no AI-specific
  // branch in assemble() or pass3: if the engine can digest a real
  // dictionary row, it can digest this one, including trigger placeholders
  // and output-bucket routing. Nothing is written to Supabase here — this
  // is a live, in-memory preview only.
  async function getAiHelp() {
    if (!result || issueTokens.length === 0) return;
    setAiRunning(true);
    const nextSuggestions = {};
    const aiRows = [];

    for (const token of issueTokens) {
      const { data, error: fnError } = await supabase.functions.invoke("ai-normalize", {
        body: { token, sample_raw_name: result.raw_name },
      });
      if (fnError) {
        let detail = fnError.message;
        try {
          const body = await fnError.context?.json();
          if (body?.error) detail = body.error;
        } catch { /* not JSON, keep fnError.message */ }
        nextSuggestions[token] = { error: detail, suggestion: null };
        continue;
      }
      if (!data?.success) {
        nextSuggestions[token] = { error: data?.error || "Unknown error", suggestion: null };
        continue;
      }
      const s = data.suggestion;
      nextSuggestions[token] = { error: null, suggestion: s };
      aiRows.push({
        id: -(aiRows.length + 1),
        synonyms: token,
        canonical_term: s.canonical_term,
        category: s.category,
        action: s.action,
        priority: 100,
        output_bucket: s.output_bucket,
        trigger_bucket: s.trigger_bucket,
      });
    }

    setAiSuggestions(nextSuggestions);

    if (aiRows.length > 0) {
      const merged = [...rows, ...aiRows].sort((a, b) => (a.priority - b.priority) || (a.id - b.id));
      const ephemeralDict = buildLookup(merged);
      const r = await normalizeCore(result.raw_name, ephemeralDict, { trace: false, diagnostics: false });
      setAiResult(r);
      buildLookup(rows); // restore real dictionary state — see note above run()
    }
    setAiRunning(false);
  }

  async function saveAsGolden() {
    if (!result) return;
    setStatus("Saving golden case…");
    const { error: dbError } = await supabase.from("golden_dataset").insert({
      raw_name: result.raw_name,
      expected: result.parsed_components,
    });
    if (dbError) {
      setStatus(dbError.message.includes("duplicate") ? "Already a golden case for this raw name." : `Failed: ${dbError.message}`);
    } else {
      setStatus("Saved as golden case.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Engine Playground</h1>
        <p className="text-base-400 text-sm mt-1">
          Paste one raw room name and see every stage of normalization, token by token.
        </p>
      </div>

      <div className="flex items-center gap-3 text-xs text-base-400">
        {loading && <span>Loading dictionary…</span>}
        {error && <span className="text-red-400">Dictionary load failed: {error}</span>}
        {dict && !loading && <span>{dict.lookup.size} dictionary terms loaded</span>}
        <button onClick={reload} className="underline hover:text-base-50">Refresh dictionary</button>
        <div className="ml-auto flex items-center gap-2">
          <span>Mode:</span>
          <div className="flex gap-1 bg-base-900 border border-base-800 rounded-md p-0.5">
            <button
              onClick={() => setMode("testing")}
              className={`px-2 py-1 rounded text-xs font-semibold ${mode === "testing" ? "bg-base-700 text-base-50" : "text-base-400 hover:text-base-50"}`}
            >
              Testing (nothing collected)
            </button>
            <button
              onClick={() => setMode("collecting")}
              className={`px-2 py-1 rounded text-xs font-semibold ${mode === "collecting" ? "bg-amber-700 text-white" : "text-base-400 hover:text-base-50"}`}
            >
              Collecting (auto-log to queue)
            </button>
          </div>
        </div>
      </div>
      {mode === "collecting" && (
        <div className="text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded-md px-3 py-2">
          Every run below is automatically logged to the Review Queue — all unresolved/unpaired/ambiguous/conflicting tokens, categorized, no manual selection needed. Switch back to Testing to try things without logging anything.
        </div>
      )}

      <div className="flex gap-3">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run(); }}
          placeholder="Paste raw room name, e.g. Loft, Balcony (Inspired Living)"
          className="flex-1 bg-base-900 border border-base-700 rounded-md p-3 text-sm min-h-[80px] resize-y focus:outline-none focus:ring-2 focus:ring-blue-600"
        />
        <button
          onClick={run}
          disabled={running || !dict}
          className="self-start px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-base-700 rounded-md font-semibold text-sm"
        >
          {running ? "Working…" : "Normalize"}
        </button>
      </div>

      {runError && <div className="text-red-400 text-sm">{runError}</div>}

      {result && (
        <div className="space-y-4">
          <div className="bg-base-900 border border-base-800 rounded-md p-3 text-sky-400 font-medium">
            {result.canonical_string}
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(result.canonical_hash)}
            className="w-full text-left bg-base-900 border border-base-800 rounded-md px-3 py-2 font-mono text-xs text-base-400 hover:border-blue-600 flex justify-between items-center"
          >
            <span className="truncate">{result.canonical_hash}</span>
            <span>📋</span>
          </button>

          <div className="bg-base-900 border border-base-800 rounded-md text-sm divide-y divide-base-800">
            {Object.entries(result.parsed_components).map(([k, v]) => {
              const val = Array.isArray(v) ? (v.length ? v.join(", ") : "—") : v ?? "—";
              return (
                <div key={k} className="flex justify-between px-3 py-1.5">
                  <span className="text-base-400 capitalize">{k}</span>
                  <span className="font-medium text-right">{val}</span>
                </div>
              );
            })}
          </div>

          <div className="flex gap-2">
            <button onClick={saveAsGolden} className="px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded-md text-xs font-semibold">
              Save as golden case
            </button>
            {status && <span className="text-xs text-base-400 self-center">{status}</span>}
          </div>

          {issues.length > 0 && (
            <div className="bg-amber-950/40 border border-amber-800 rounded-md p-3 space-y-2">
              <div className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
                {issues.length} context issue{issues.length === 1 ? "" : "s"} flagged
              </div>
              {issues.map((iss, i) => (
                <div key={i} className="text-xs text-amber-200">
                  <span className="font-semibold">{ISSUE_LABELS[iss.kind] || iss.kind}</span> — "{iss.token}": {iss.explanation}
                </div>
              ))}
              <button
                onClick={getAiHelp}
                disabled={aiRunning}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-base-700 rounded-md text-xs font-semibold"
              >
                {aiRunning ? "Asking AI…" : "Get AI help"}
              </button>

              {Object.keys(aiSuggestions).length > 0 && (
                <div className="grid gap-2 sm:grid-cols-2 pt-1">
                  {issueTokens.map((token) => {
                    const entry = aiSuggestions[token];
                    if (!entry) return null;
                    return (
                      <div key={token} className="bg-base-950 border border-blue-900 rounded-md p-2.5 text-xs space-y-1">
                        <div className="font-mono text-yellow-200">{token}</div>
                        {entry.error && <div className="text-red-400">{entry.error}</div>}
                        {entry.suggestion && (
                          <>
                            <div className="flex justify-between"><span className="text-base-400">Category</span><span className="font-semibold">{entry.suggestion.category}</span></div>
                            {entry.suggestion.output_bucket && <div className="flex justify-between"><span className="text-base-400">Output bucket</span><span className="font-semibold">{entry.suggestion.output_bucket}</span></div>}
                            {entry.suggestion.trigger_bucket && <div className="flex justify-between"><span className="text-base-400">Trigger bucket</span><span className="font-semibold text-amber-300">{entry.suggestion.trigger_bucket}</span></div>}
                            <div className="flex justify-between"><span className="text-base-400">Canonical</span><span className="font-semibold">{entry.suggestion.canonical_term}</span></div>
                            <div className="flex justify-between">
                              <span className="text-base-400">Confidence</span>
                              <span className={entry.suggestion.confidence >= 0.75 ? "text-green-400" : entry.suggestion.confidence >= 0.5 ? "text-yellow-300" : "text-red-400"}>
                                {Math.round(entry.suggestion.confidence * 100)}%
                              </span>
                            </div>
                            <div className="text-base-400 italic">"{entry.suggestion.reasoning}"</div>
                            <Link
                              to={`/dictionary?newSynonym=${encodeURIComponent(token)}&category=${encodeURIComponent(entry.suggestion.category)}&canonical=${encodeURIComponent(entry.suggestion.canonical_term)}&output_bucket=${encodeURIComponent(entry.suggestion.output_bucket || "")}&trigger_bucket=${encodeURIComponent(entry.suggestion.trigger_bucket || "")}`}
                              className="inline-block text-sky-400 hover:text-sky-300 underline"
                            >
                              Review &amp; add to dictionary →
                            </Link>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {aiResult && (
                <div className="pt-1">
                  <div className="text-xs text-base-400 mb-1">Live preview — engine re-run with the AI suggestions above merged into the dictionary (not saved):</div>
                  <div className="bg-base-950 border border-blue-800 rounded-md p-3 text-blue-300 font-medium text-sm">
                    {aiResult.canonical_string}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="border-t border-base-800 pt-4">
            <div className="text-xs uppercase tracking-wide text-base-400 mb-2 font-semibold">Token Decisions</div>
            <div className="flex flex-wrap gap-2 mb-3">
              {explanations.map((exp) => (
                <TokenChip
                  key={exp.index}
                  exp={exp}
                  selected={exp.index === selected?.index}
                  onClick={() => setSelectedIndex(exp.index)}
                />
              ))}
            </div>
            <TokenDetail exp={selected} />
          </div>

          <details className="border-t border-base-800 pt-3 text-sm">
            <summary className="text-base-400 cursor-pointer hover:text-base-50">Pipeline stages ▸</summary>
            <div className="mt-2 space-y-2">
              {(result.trace || []).map((stage, i) => (
                <div key={i} className="bg-base-900 border border-base-800 rounded-md p-2">
                  <div className="text-xs font-semibold text-base-200 mb-1">
                    {STAGE_LABELS[stage.stage] || stage.stage}
                  </div>
                  <div className="font-mono text-xs text-base-400">
                    {stage.tokens.map((t) => `${t.text}${t.claimed_by ? ` → ${t.claimed_by}` : ""}`).join("  |  ") || "(no tokens)"}
                  </div>
                </div>
              ))}
            </div>
          </details>

          <details className="border-t border-base-800 pt-3 text-sm">
            <summary className="text-base-400 cursor-pointer hover:text-base-50">Review events / rule hits ▸</summary>
            <pre className="mt-2 bg-base-900 border border-base-800 rounded-md p-2 text-xs text-base-400 overflow-auto max-h-64">
{JSON.stringify({ diagnostics: result.diagnostics, rule_hits: result.rule_hits }, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
