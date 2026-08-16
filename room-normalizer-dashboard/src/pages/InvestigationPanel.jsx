import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { normalizeCore, buildTokenExplanations, TOKEN_STATUS } from "../engine/normalizerEngine";

const FIELDS = ["class", "occupancy", "type", "bedroom", "bedding", "view", "building", "amenity", "conditional", "custom"];

function fieldToText(v) {
  if (v === null || v === undefined) return "";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

function textToField(text, wasArray) {
  const t = text.trim();
  if (!t) return null;
  return wasArray ? t.split(",").map((s) => s.trim()).filter(Boolean) : t;
}

// ------------------------------------------------------------
// Auto-suggested cause — replaces the manual root-cause dropdown. Purely
// deterministic, reads only the diff + the same evidence buildTokenExplanations
// already computes for the Playground. Not authoritative, just a pointer.
// ------------------------------------------------------------
function suggestCause(mismatchedFields, evidence, actualText) {
  if (mismatchedFields.length === 0) return null;

  const suggestions = [];
  for (const field of mismatchedFields) {
    const expectedWords = fieldToText(field.expectedVal).toLowerCase();
    const relatedEvidence = evidence.filter((e) => expectedWords.includes(e.text.toLowerCase()));

    if (relatedEvidence.length === 0) {
      suggestions.push({ field: field.field, cause: "DICTIONARY", note: `No token in "${actualText}" matches the words in your expected "${field.field}" — likely a missing dictionary entry.` });
      continue;
    }

    const hasMatch = relatedEvidence.some((e) => e.dictionaryMatch);
    const hasClaimedRule = relatedEvidence.some((e) => e.claimedRule);
    if (hasMatch && !hasClaimedRule) {
      // Number present alongside a recognized type but not connected to it
      const hasNumberNearby = /\d/.test(expectedWords) && !/\d/.test(relatedEvidence.map((e) => e.text).join(" "));
      if (hasNumberNearby) {
        suggestions.push({ field: field.field, cause: "QUANTITY_ASSOCIATION", note: `"${relatedEvidence[0].text}" is already recognized by the dictionary, but the quantity in your expected value wasn't attached to it. Likely a structural rule not linking number + type.` });
      } else {
        suggestions.push({ field: field.field, cause: "STRUCTURAL_RULE", note: `"${relatedEvidence[0].text}" is already recognized by the dictionary (${relatedEvidence[0].dictionaryMatch?.category}), but no structural rule connected it to the "${field.field}" output. Not a dictionary gap.` });
      }
      continue;
    }
    if (field.field === "conditional") {
      suggestions.push({ field: field.field, cause: "CONDITIONAL_LOGIC", note: "Expected a conditional phrase to be recognized — check whether the exact wording is in the CONDITIONAL dictionary category." });
      continue;
    }
    suggestions.push({ field: field.field, cause: "UNKNOWN", note: `Evidence for "${field.field}" doesn't clearly point to one cause — worth a closer manual look.` });
  }
  return suggestions;
}

export default function InvestigationPanel({ row, dict, onClose }) {
  const [selectedRaw, setSelectedRaw] = useState(row.sample_raw_names?.[0] || "");
  const [actual, setActual] = useState(null);
  const [evidence, setEvidence] = useState([]);
  const [runError, setRunError] = useState(null);

  const [expected, setExpected] = useState({});
  const [touched, setTouched] = useState({});

  const [creatingRegression, setCreatingRegression] = useState(false);
  const [regressionStatus, setRegressionStatus] = useState(null);

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

  const mismatched = diffRows.filter((d) => d.isTouched && !d.matches);
  const suggestions = useMemo(() => (actual ? suggestCause(mismatched, evidence, selectedRaw) : null), [mismatched, evidence, actual, selectedRaw]);

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

  async function createRegressionCase() {
    if (!actual) return;
    const anyTouched = Object.values(touched).some(Boolean);
    if (!anyTouched) return;
    setCreatingRegression(true);
    setRegressionStatus(null);
    const mergedExpected = { ...actual.parsed_components, ...expected };
    const causeNote = suggestions?.length ? `Suggested cause: ${suggestions.map((s) => s.cause).join(", ")}.` : "";
    const { error } = await supabase.from("golden_dataset").insert({
      raw_name: selectedRaw,
      expected: mergedExpected,
      notes: `From Review Queue investigation #${row.id} (${row.kind}/${row.diagnostic_code || "—"}). ${causeNote}`.trim(),
    });
    setCreatingRegression(false);
    if (error) {
      setRegressionStatus(error.message.includes("duplicate") ? "A golden case for this raw name already exists." : `Failed: ${error.message}`);
    } else {
      setRegressionStatus("Added to Regression Tests.");
      if (suggestions?.length) {
        await supabase.rpc("update_review_investigation", {
          p_review_id: row.id,
          p_root_cause: suggestions[0].cause,
          p_root_cause_confidence: "MEDIUM",
          p_investigation_status: "ROOT_CAUSE_IDENTIFIED",
        });
      }
    }
  }

  const canCreateRegression = Object.values(touched).some(Boolean);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center pt-8 pb-8 z-50 overflow-auto" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-base-900 border border-base-700 rounded-md w-full max-w-3xl mx-4 max-h-[90vh] overflow-auto">
        <div className="sticky top-0 bg-base-900 border-b border-base-800 px-5 py-3 flex justify-between items-start z-10">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold text-base-50 text-lg">{row.token}</span>
              <span className="text-xs px-1.5 py-0.5 rounded border text-base-300 bg-base-800 border-base-700">{row.kind}</span>
              {row.diagnostic_code && <span className="text-xs text-base-500">{row.diagnostic_code}</span>}
            </div>
            <div className="text-xs text-base-400 mt-1">{row.occurrence_count}× occurrences</div>
          </div>
          <button onClick={onClose} className="text-base-400 hover:text-base-50 text-lg">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {row.sample_raw_names?.length > 1 && (
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
          )}

          {runError && <div className="text-red-400 text-sm">{runError}</div>}

          {actual && (
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <div className="text-xs uppercase tracking-wide text-base-400 font-semibold">Expected Output</div>
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
                      placeholder="(unset)"
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

          {suggestions?.length > 0 && (
            <div className="border-t border-base-800 pt-3">
              <div className="text-xs uppercase tracking-wide text-base-400 font-semibold mb-2">Suggested Cause</div>
              <div className="space-y-2">
                {suggestions.map((s, i) => (
                  <div key={i} className="text-xs bg-base-950 border border-base-800 rounded-md p-2">
                    <span className="font-semibold text-amber-300">{s.cause}</span>
                    <span className="text-base-400"> — {s.note}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {evidence.length > 0 && (
            <details className="border-t border-base-800 pt-3">
              <summary className="text-xs uppercase tracking-wide text-base-400 font-semibold cursor-pointer">Engine Evidence (raw)</summary>
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
                        {exp.dictionaryMatch ? `${exp.dictionaryMatch.canonical || "—"} (${exp.dictionaryMatch.category})` : <span className="text-base-600">no match</span>}
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

          <div className="border-t border-base-800 pt-3">
            {!canCreateRegression ? (
              <div className="text-xs text-base-500">Set at least one Expected field above to create a regression case.</div>
            ) : (
              <div className="bg-base-950 border border-base-800 rounded-md p-3 space-y-2">
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
