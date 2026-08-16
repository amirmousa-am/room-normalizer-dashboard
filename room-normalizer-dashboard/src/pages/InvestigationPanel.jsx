import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { normalizeCore, buildTokenExplanations, TOKEN_STATUS } from "../engine/normalizerEngine";

const FIELDS = ["class", "occupancy", "type", "bedroom", "bedding", "view", "building", "amenity", "conditional", "custom"];

const ROOT_CAUSES = [
  "DICTIONARY", "TOKENIZATION", "EXPANSION", "STRUCTURAL_RULE",
  "QUANTITY_ASSOCIATION", "CONTEXT", "CONDITIONAL_LOGIC",
  "OUTPUT_ASSEMBLY", "AMBIGUITY", "DATA_ISSUE", "UNKNOWN",
];
const CONFIDENCES = ["LOW", "MEDIUM", "HIGH"];
const SCOPES = ["TOKEN", "PHRASE", "RELATIONSHIP", "WHOLE_INPUT"];
const INVESTIGATION_STATUSES = ["NEW", "INVESTIGATING", "ROOT_CAUSE_IDENTIFIED", "FIXED", "REGRESSION_ADDED", "IGNORED"];

function fieldToText(v) {
  if (v === null || v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

function textToField(text, wasArray) {
  const t = text.trim();
  if (!t) return null;
  return wasArray ? t.split(",").map((s) => s.trim()).filter(Boolean) : t;
}

// Heuristic "possible engine-level issue" warning — derived entirely from
// the existing `kind` field, no new detection logic. UNPAIRED_SEMANTIC and
// CONFLICTING_BEDDING both mean the dictionary already recognized the
// term(s); the failure is downstream of dictionary lookup.
function engineWarning(kind) {
  if (kind === "UNPAIRED_SEMANTIC") {
    return "The dictionary already recognizes this term — no dictionary edit will fix this. The structural rule that should have consumed it didn't. Likely STRUCTURAL_RULE or CONTEXT.";
  }
  if (kind === "CONFLICTING_BEDDING") {
    return "Both bedding types are already in the dictionary. This is a structural/association ambiguity, not a coverage gap. Likely QUANTITY_ASSOCIATION or AMBIGUITY.";
  }
  if (kind === "AMBIGUOUS_DROP") {
    return "The engine intentionally dropped this for lacking context. Only investigate if this case should have had enough context to resolve.";
  }
  if (kind === "UNRESOLVED") {
    return "No dictionary entry matched at all — this one is more likely a genuine DICTIONARY coverage gap.";
  }
  return null;
}

export default function InvestigationPanel({ row, dict, onClose, onInvestigationSaved }) {
  const [selectedRaw, setSelectedRaw] = useState(row.sample_raw_names?.[0] || "");
  const [actual, setActual] = useState(null);
  const [evidence, setEvidence] = useState([]);
  const [runError, setRunError] = useState(null);

  const [expected, setExpected] = useState({});
  const [touched, setTouched] = useState({});

  const [rootCause, setRootCause] = useState(row.root_cause || "");
  const [confidence, setConfidence] = useState(row.root_cause_confidence || "");
  const [scope, setScope] = useState(row.issue_scope || "");
  const [notes, setNotes] = useState(row.investigation_notes || "");
  const [investigationStatus, setInvestigationStatus] = useState(row.investigation_status || "NEW");
  const [savingInvestigation, setSavingInvestigation] = useState(false);
  const [investigationSaved, setInvestigationSaved] = useState(false);

  const [similar, setSimilar] = useState(null);
  const [similarNote, setSimilarNote] = useState(null);

  const [creatingRegression, setCreatingRegression] = useState(false);
  const [regressionStatus, setRegressionStatus] = useState(null);

  // --- Run the live engine against the selected sample (same approach as Recheck) ---
  useEffect(() => {
    if (!selectedRaw || !dict) return;
    setRunError(null);
    normalizeCore(selectedRaw, dict, { trace: true, diagnostics: true })
      .then((r) => {
        setActual(r);
        setEvidence(buildTokenExplanations(r.diagnosticsReport, r));
      })
      .catch((e) => setRunError(e.message || String(e)));
  }, [selectedRaw, dict]);

  // --- Similar cases: deterministic matching only, no AI/embedding similarity ---
  useEffect(() => {
    let cancelled = false;
    async function loadSimilar() {
      const results = new Map();
      const notes = [];

      const { data: sameKind, error: e1 } = await supabase
        .from("review_queue")
        .select("id, token, kind, diagnostic_code, occurrence_count, sample_raw_names")
        .eq("kind", row.kind)
        .eq("diagnostic_code", row.diagnostic_code || "")
        .neq("id", row.id)
        .limit(10);
      if (!e1 && sameKind) sameKind.forEach((r) => results.set(r.id, { ...r, reason: "same kind + diagnostic code" }));
      else if (e1) notes.push(`Same-pattern query failed: ${e1.message}`);

      const words = row.token.split(/\s+/).filter((w) => w.length > 2);
      if (words.length) {
        const orFilter = words.map((w) => `token.ilike.%${w}%`).join(",");
        const { data: wordMatches, error: e2 } = await supabase
          .from("review_queue")
          .select("id, token, kind, diagnostic_code, occurrence_count, sample_raw_names")
          .or(orFilter)
          .neq("id", row.id)
          .limit(10);
        if (!e2 && wordMatches) wordMatches.forEach((r) => { if (!results.has(r.id)) results.set(r.id, { ...r, reason: "shares a word with this token" }); });
        else if (e2) notes.push(`Word-overlap query failed: ${e2.message}`);
      }

      notes.push(
        "Matching is limited to what's already stored: same kind+diagnostic_code, or word overlap on the token text. " +
        "There's no stored linguistic category (e.g. \"bedding quantity issue\") to match on beyond that — " +
        "classifying more cases with Root Cause below will make this matching better over time."
      );

      if (!cancelled) {
        setSimilar([...results.values()].slice(0, 10));
        setSimilarNote(notes.join(" "));
      }
    }
    loadSimilar();
    return () => { cancelled = true; };
  }, [row.id, row.kind, row.diagnostic_code, row.token]);

  const diffRows = useMemo(() => {
    if (!actual) return [];
    return FIELDS.map((f) => {
      const actualVal = actual.parsed_components[f];
      const expectedVal = expected[f];
      const isTouched = !!touched[f];
      let matches = null;
      if (isTouched) {
        const norm = (v) => (Array.isArray(v) ? v.map((s) => s.toLowerCase().trim()).sort().join(",") : (v || "").toString().toLowerCase().trim());
        matches = norm(expectedVal) === norm(actualVal);
      }
      return { field: f, actualVal, expectedVal, isTouched, matches };
    });
  }, [actual, expected, touched]);

  function setExpectedField(field, text) {
    const wasArray = Array.isArray(actual?.parsed_components?.[field]);
    setExpected((prev) => ({ ...prev, [field]: textToField(text, wasArray) }));
    setTouched((prev) => ({ ...prev, [field]: true }));
  }

  function copyActualAsBaseline() {
    if (!actual) return;
    setExpected({ ...actual.parsed_components });
    setTouched(Object.fromEntries(FIELDS.map((f) => [f, true])));
  }

  async function saveInvestigation() {
    setSavingInvestigation(true);
    setInvestigationSaved(false);
    const { error } = await supabase.rpc("update_review_investigation", {
      p_review_id: row.id,
      p_investigation_status: investigationStatus || null,
      p_root_cause: rootCause || null,
      p_root_cause_confidence: confidence || null,
      p_issue_scope: scope || null,
      p_investigation_notes: notes || null,
    });
    setSavingInvestigation(false);
    if (!error) {
      setInvestigationSaved(true);
      onInvestigationSaved?.(row.id, { investigation_status: investigationStatus, root_cause: rootCause, root_cause_confidence: confidence, issue_scope: scope, investigation_notes: notes });
    }
  }

  async function createRegressionCase() {
    if (!actual) return;
    const anyTouched = Object.values(touched).some(Boolean);
    if (!anyTouched) return;
    setCreatingRegression(true);
    setRegressionStatus(null);
    const mergedExpected = { ...actual.parsed_components, ...expected };
    const { error } = await supabase.from("golden_dataset").insert({
      raw_name: selectedRaw,
      expected: mergedExpected,
      notes: `From Review Queue investigation #${row.id} (${row.kind}/${row.diagnostic_code || "—"}). ${notes || ""}`.trim(),
    });
    setCreatingRegression(false);
    if (error) {
      setRegressionStatus(error.message.includes("duplicate") ? "A golden case for this raw name already exists." : `Failed: ${error.message}`);
    } else {
      setRegressionStatus("Added to Regression Tests.");
      if (investigationStatus !== "REGRESSION_ADDED") {
        setInvestigationStatus("REGRESSION_ADDED");
        await supabase.rpc("update_review_investigation", { p_review_id: row.id, p_investigation_status: "REGRESSION_ADDED" });
        onInvestigationSaved?.(row.id, { investigation_status: "REGRESSION_ADDED" });
      }
    }
  }

  const warning = engineWarning(row.kind);
  const canCreateRegression = Object.values(touched).some(Boolean);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center pt-8 pb-8 z-50 overflow-auto" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-base-900 border border-base-700 rounded-md w-full max-w-4xl mx-4 max-h-[90vh] overflow-auto">
        {/* Header / Problem Summary */}
        <div className="sticky top-0 bg-base-900 border-b border-base-800 px-5 py-3 flex justify-between items-start z-10">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold text-base-50 text-lg">{row.token}</span>
              <span className="text-xs px-1.5 py-0.5 rounded border text-base-300 bg-base-800 border-base-700">{row.kind}</span>
              {row.diagnostic_code && <span className="text-xs text-base-500">{row.diagnostic_code}</span>}
            </div>
            <div className="text-xs text-base-400 mt-1">
              {row.occurrence_count}× occurrences · first seen {row.first_seen ? new Date(row.first_seen).toLocaleDateString() : "—"} · last seen {new Date(row.last_seen).toLocaleDateString()}
            </div>
          </div>
          <button onClick={onClose} className="text-base-400 hover:text-base-50 text-lg">✕</button>
        </div>

        <div className="p-5 space-y-5">
          {warning && (
            <div className="text-xs text-amber-200 bg-amber-950/40 border border-amber-800 rounded-md px-3 py-2">
              <strong>Possible engine-level issue:</strong> {warning}
            </div>
          )}

          {/* Sample picker */}
          {row.sample_raw_names?.length > 1 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-base-400 font-semibold mb-1.5">Sample raw name</div>
              <div className="flex flex-wrap gap-1.5">
                {row.sample_raw_names.map((raw) => (
                  <button
                    key={raw}
                    onClick={() => { setSelectedRaw(raw); setExpected({}); setTouched({}); }}
                    className={`text-xs px-2 py-1 rounded font-mono ${selectedRaw === raw ? "bg-blue-600 text-white" : "bg-base-800 text-base-300 hover:bg-base-700"}`}
                  >
                    {raw}
                  </button>
                ))}
              </div>
            </div>
          )}

          {runError && <div className="text-red-400 text-sm">{runError}</div>}

          {/* Actual vs Expected */}
          {actual && (
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <div className="text-xs uppercase tracking-wide text-base-400 font-semibold">Actual vs Expected</div>
                <button onClick={copyActualAsBaseline} className="text-xs text-sky-400 hover:text-sky-300 underline">
                  Copy actual as starting point
                </button>
              </div>
              <div className="text-xs text-base-500 mb-2">
                Current engine output: <span className="text-sky-400 font-mono">{actual.canonical_string}</span>
              </div>
              <div className="border border-base-800 rounded-md overflow-hidden">
                <div className="grid grid-cols-[100px_1fr_1fr_28px] bg-base-950 text-xs uppercase text-base-500 px-3 py-1.5 font-semibold">
                  <div>Field</div><div>Actual</div><div>Expected</div><div></div>
                </div>
                {diffRows.map((d) => (
                  <div key={d.field} className={`grid grid-cols-[100px_1fr_1fr_28px] items-center px-3 py-1.5 border-t border-base-800 ${d.isTouched && !d.matches ? "bg-red-950/30" : ""}`}>
                    <div className="text-xs text-base-400 capitalize">{d.field}</div>
                    <div className="text-xs font-mono text-base-300">{fieldToText(d.actualVal) || <span className="text-base-600">—</span>}</div>
                    <input
                      value={fieldToText(d.expectedVal)}
                      onChange={(e) => setExpectedField(d.field, e.target.value)}
                      placeholder="(unset — click a value to define)"
                      className="text-xs font-mono bg-base-950 border border-base-800 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-600"
                    />
                    <div className="text-center">
                      {d.isTouched ? (d.matches ? <span className="text-green-400">✓</span> : <span className="text-red-400">✕</span>) : <span className="text-base-700">—</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Engine Evidence */}
          {evidence.length > 0 && (
            <details className="border-t border-base-800 pt-3" open>
              <summary className="text-xs uppercase tracking-wide text-base-400 font-semibold cursor-pointer">Engine Evidence</summary>
              <div className="mt-2 border border-base-800 rounded-md overflow-hidden text-xs">
                <div className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] bg-base-950 text-base-500 uppercase font-semibold px-3 py-1.5">
                  <div>Token</div><div>Dict Match</div><div>Claimed By</div><div>Status</div><div>Final Location</div>
                </div>
                {evidence.map((exp) => {
                  const cfg = TOKEN_STATUS[exp.status] || TOKEN_STATUS.unresolved;
                  return (
                    <div key={exp.index} className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] px-3 py-1.5 border-t border-base-800 items-center">
                      <div className="font-mono text-base-200">{exp.text}</div>
                      <div className="text-base-400">
                        {exp.dictionaryMatch
                          ? `${exp.dictionaryMatch.canonical || "—"} (${exp.dictionaryMatch.category}/${exp.dictionaryMatch.action})`
                          : <span className="text-base-600">no match</span>}
                      </div>
                      <div className="text-base-400">{exp.claimedRule || <span className="text-base-600">none</span>}</div>
                      <div>{cfg.icon} {cfg.label}</div>
                      <div className="text-base-500">{exp.finalComponent || "—"}</div>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {/* Root Cause classification */}
          <div className="border-t border-base-800 pt-3">
            <div className="text-xs uppercase tracking-wide text-base-400 font-semibold mb-2">Root Cause (investigation annotation only — does not change the engine)</div>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <label className="text-xs text-base-400">
                Root cause
                <select value={rootCause} onChange={(e) => setRootCause(e.target.value)} className="mt-1 w-full bg-base-950 border border-base-700 rounded px-2 py-1.5 text-sm">
                  <option value="">— unset —</option>
                  {ROOT_CAUSES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="text-xs text-base-400">
                Confidence
                <select value={confidence} onChange={(e) => setConfidence(e.target.value)} className="mt-1 w-full bg-base-950 border border-base-700 rounded px-2 py-1.5 text-sm">
                  <option value="">— unset —</option>
                  {CONFIDENCES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="text-xs text-base-400">
                Issue scope
                <select value={scope} onChange={(e) => setScope(e.target.value)} className="mt-1 w-full bg-base-950 border border-base-700 rounded px-2 py-1.5 text-sm">
                  <option value="">— unset —</option>
                  {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-xs text-base-400 mb-2">
              Investigation status
              <select value={investigationStatus} onChange={(e) => setInvestigationStatus(e.target.value)} className="mt-1 w-full bg-base-950 border border-base-700 rounded px-2 py-1.5 text-sm">
                {INVESTIGATION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="block text-xs text-base-400 mb-2">
              Notes
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full bg-base-950 border border-base-700 rounded px-2 py-1.5 text-sm min-h-[60px]" />
            </label>
            <div className="flex items-center gap-2">
              <button onClick={saveInvestigation} disabled={savingInvestigation} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-base-700 rounded-md text-xs font-semibold">
                {savingInvestigation ? "Saving…" : "Save Investigation"}
              </button>
              {investigationSaved && <span className="text-xs text-green-400">Saved.</span>}
            </div>
          </div>

          {/* Similar Cases */}
          <div className="border-t border-base-800 pt-3">
            <div className="text-xs uppercase tracking-wide text-base-400 font-semibold mb-2">Similar Cases</div>
            {similar === null ? (
              <div className="text-xs text-base-500">Loading…</div>
            ) : similar.length === 0 ? (
              <div className="text-xs text-base-500">No matching rows found by kind/diagnostic code or token word overlap.</div>
            ) : (
              <div className="space-y-1 mb-2">
                {similar.map((s) => (
                  <div key={s.id} className="text-xs flex justify-between bg-base-950 border border-base-800 rounded px-2 py-1.5">
                    <span className="font-mono text-base-200">{s.token}</span>
                    <span className="text-base-500">{s.occurrence_count}× · {s.reason}</span>
                  </div>
                ))}
              </div>
            )}
            {similarNote && <div className="text-xs text-base-600 italic">{similarNote}</div>}
          </div>

          {/* Regression Case */}
          <div className="border-t border-base-800 pt-3">
            <div className="text-xs uppercase tracking-wide text-base-400 font-semibold mb-2">Regression Case</div>
            {!canCreateRegression ? (
              <div className="text-xs text-base-500">Define at least one Expected field above before creating a regression case.</div>
            ) : (
              <div className="bg-base-950 border border-base-800 rounded-md p-3 space-y-2">
                <div className="text-xs text-base-400">Input: <span className="font-mono text-base-200">{selectedRaw}</span></div>
                <div className="text-xs text-base-400">
                  Expected fields set: {Object.keys(touched).filter((k) => touched[k]).join(", ")}
                </div>
                <button
                  onClick={createRegressionCase}
                  disabled={creatingRegression}
                  className="px-3 py-1.5 bg-green-700 hover:bg-green-600 disabled:bg-base-700 rounded-md text-xs font-semibold"
                >
                  {creatingRegression ? "Adding…" : "Add to Regression Tests"}
                </button>
                {regressionStatus && <div className="text-xs text-base-400">{regressionStatus}</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
