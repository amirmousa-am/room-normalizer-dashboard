import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useDictionary } from "../engine/useDictionary";
import {
  normalizeCore,
  buildTokenExplanations,
  TOKEN_STATUS,
  createCollector,
} from "../engine/normalizerEngine";

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
  const { dict, loading, error, reload } = useDictionary();
  const [raw, setRaw] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState("testing"); // "testing" | "collecting"
  const collectorRef = useRef(null);

  function getCollector() {
    if (!collectorRef.current) collectorRef.current = createCollector("playground", supabase);
    return collectorRef.current;
  }

  const explanations = useMemo(() => {
    if (!result?.diagnosticsReport) return [];
    return buildTokenExplanations(result.diagnosticsReport, result);
  }, [result]);

  const selected = explanations.find((e) => e.index === selectedIndex) || explanations[0];

  async function run() {
    if (!raw.trim() || !dict) return;
    setRunning(true);
    setRunError(null);
    setStatus(null);
    try {
      const r = await normalizeCore(raw.trim(), dict, { trace: true, diagnostics: true });
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
