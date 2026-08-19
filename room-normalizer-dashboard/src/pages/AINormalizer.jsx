import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDictionary } from "../engine/useDictionary";
import { normalizeCore, DICTIONARY_CATEGORIES } from "../engine/normalizerEngine";

// ============================================================
// AI Normalizer — isolated test tab.
//
// This page does NOT touch the main normalizeCore pipeline. It runs the
// engine exactly as Playground does. If the engine flags a context issue on
// that case — CONFLICTING_BEDDING, AMBIGUOUS_DROP, UNRESOLVED, or
// UNPAIRED_SEMANTIC (result.diagnostics, populated regardless of the
// diagnostics option) — the case gets a "Run full AI normalization" option.
// That single AI call re-normalizes the WHOLE raw name (not just the flagged
// phrase), with the live dictionary given as context so it reuses your
// existing canonical terms/categories instead of inventing new phrasing for
// things you already have a rule for.
//
// Nothing here writes to Supabase. Any new term the AI proposes still goes
// through the normal Dictionary Manager form via the ?newSynonym= deep link
// — same manual-confirm pattern as Review Queue.
// ============================================================

const API_KEY_STORAGE_KEY = "ai_normalizer_gemini_key";
const MODEL_OPTIONS = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (balanced)" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite (fastest / highest free quota)" },
];
const ISSUE_KINDS = new Set(["CONFLICTING_BEDDING", "AMBIGUOUS_DROP", "UNRESOLVED", "UNPAIRED_SEMANTIC"]);
const ISSUE_LABELS = {
  CONFLICTING_BEDDING: "Conflicting bedding",
  AMBIGUOUS_DROP: "Ambiguous — dropped",
  UNRESOLVED: "Unresolved token",
  UNPAIRED_SEMANTIC: "Recognized but unpaired",
};
const DICT_CONTEXT_CHAR_CAP = 120000; // ~30k tokens — generous headroom, keeps prompts sane

// Compact "CATEGORY: canonical [synonym, synonym...]" listing so the model
// can match against what already exists instead of inventing new phrasing
// for something you already have a dictionary row for.
function buildDictionaryContext(rows) {
  if (!rows?.length) return { text: "(dictionary is empty)", truncated: false };
  const byCategory = {};
  for (const r of rows) {
    (byCategory[r.category] ||= []).push(`${r.canonical_term} [${r.synonyms}]`);
  }
  const text = Object.entries(byCategory)
    .map(([cat, terms]) => `${cat}:\n${terms.join("\n")}`)
    .join("\n\n");
  if (text.length <= DICT_CONTEXT_CHAR_CAP) return { text, truncated: false };
  return { text: text.slice(0, DICT_CONTEXT_CHAR_CAP), truncated: true };
}

function buildFullPrompt({ rawName, issues, dictionaryText, dictionaryTruncated }) {
  return `You are re-normalizing a hotel room name for a dictionary-driven normalization engine.

RAW ROOM NAME: "${rawName}"

The rule-based engine flagged this case with the following issue(s) it could not resolve on its own:
${issues.map((i) => `- [${i.kind}] "${i.token}" — ${i.explanation}`).join("\n")}

EXISTING DICTIONARY (category: canonical_term [known synonyms]) — reuse these canonical terms and categories
whenever the raw name matches something already here. Only propose a brand-new term when nothing below covers it.
${dictionaryTruncated ? "(dictionary list truncated to fit — treat absence of a term here as inconclusive, not proof it doesn't exist)\n" : ""}${dictionaryText}

Valid categories for any term (existing or new): ${DICTIONARY_CATEGORIES.join(", ")}

Special "trigger" terms — these mean a whole bucket is unspecified rather than contributing their own visible
text. If the raw name matches "Run Of House", "Assigned On Arrival", or "Shared Accommodation" (or any close
variant), output class/occupancy/type/building all empty and bedroom null, and set canonical_string's room
segment to literally "(Non Specified Room)". If it matches "Bed Subject To Availability", set bedding to
literally "(Bed Not Specified)" instead of a specific bed type. Standalone "Subject to Availability", "On
Request", and "Upon Booking" are NOT triggers — treat those as normal OTHER terms, visible as-is.

Produce a full re-normalization of the raw name as JSON:
- class, occupancy, type, building, accessibility, other: arrays of canonical terms (empty array if none)
- bedroom: string or null
- bedding: string or null (e.g. "2 Single Beds", or the literal placeholder above if triggered)
- view: string or null
- canonical_string: the full assembled name, categories comma-separated, using the same shape as
  "<Class Occupancy Type Bedroom>, <Bedding>, <View>, <Building>, <Accessibility>, <Other>" (omit empty segments)
- new_terms: array of any phrase from the raw name that isn't covered by the existing dictionary above — each
  with phrase, category (or "NOISE" if it's not a real attribute), canonical_term, confidence (0-1), reasoning
- notes: brief string on anything a human should double check

Respond with only the JSON object matching the schema.`;
}

async function callGemini({ apiKey, model, prompt, schema }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content — check the response was not blocked by safety filters.");
  return JSON.parse(text);
}

const FULL_SCHEMA = {
  type: "OBJECT",
  properties: {
    class: { type: "ARRAY", items: { type: "STRING" } },
    occupancy: { type: "ARRAY", items: { type: "STRING" } },
    type: { type: "ARRAY", items: { type: "STRING" } },
    bedroom: { type: "STRING", nullable: true },
    bedding: { type: "STRING", nullable: true },
    view: { type: "STRING", nullable: true },
    building: { type: "ARRAY", items: { type: "STRING" } },
    accessibility: { type: "ARRAY", items: { type: "STRING" } },
    other: { type: "ARRAY", items: { type: "STRING" } },
    canonical_string: { type: "STRING" },
    new_terms: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          phrase: { type: "STRING" },
          category: { type: "STRING", enum: DICTIONARY_CATEGORIES.concat(["NOISE"]) },
          canonical_term: { type: "STRING" },
          confidence: { type: "NUMBER" },
          reasoning: { type: "STRING" },
        },
        required: ["phrase", "category", "canonical_term", "confidence", "reasoning"],
      },
    },
    notes: { type: "STRING" },
  },
  required: ["class", "occupancy", "type", "building", "accessibility", "other", "canonical_string", "new_terms", "notes"],
};

function ComponentRow({ label, engineVal, aiVal }) {
  const e = Array.isArray(engineVal) ? (engineVal.length ? engineVal.join(", ") : "—") : engineVal ?? "—";
  const a = Array.isArray(aiVal) ? (aiVal.length ? aiVal.join(", ") : "—") : aiVal ?? "—";
  const differs = JSON.stringify(engineVal ?? null) !== JSON.stringify(aiVal ?? null);
  return (
    <div className={`grid grid-cols-[100px_1fr_1fr] gap-2 px-3 py-1.5 ${differs ? "bg-amber-950/30" : ""}`}>
      <span className="text-base-400 capitalize text-xs pt-0.5">{label}</span>
      <span className="text-xs">{e}</span>
      <span className={`text-xs ${differs ? "text-amber-300 font-medium" : ""}`}>{a}</span>
    </div>
  );
}

export default function AINormalizer() {
  const { dict, rows, loading: dictLoading, error: dictError } = useDictionary();
  const [raw, setRaw] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [result, setResult] = useState(null);

  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE_KEY) || "");
  const [model, setModel] = useState(MODEL_OPTIONS[0].id);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiResult, setAiResult] = useState(null);

  const issues = useMemo(
    () => (result?.diagnostics || []).filter((d) => ISSUE_KINDS.has(d.kind)),
    [result]
  );

  function saveApiKey(value) {
    setApiKey(value);
    localStorage.setItem(API_KEY_STORAGE_KEY, value);
  }

  async function run() {
    if (!raw.trim() || !dict) return;
    setRunning(true);
    setRunError(null);
    setAiResult(null);
    setAiError(null);
    try {
      const r = await normalizeCore(raw.trim(), dict, { trace: false, diagnostics: false });
      setResult(r);
    } catch (err) {
      setRunError(err.message || String(err));
    } finally {
      setRunning(false);
    }
  }

  async function runFullAi() {
    if (!apiKey) {
      setAiError("Add a Gemini API key above first.");
      return;
    }
    setAiRunning(true);
    setAiError(null);
    try {
      const { text: dictionaryText, truncated } = buildDictionaryContext(rows);
      const prompt = buildFullPrompt({
        rawName: result.raw_name,
        issues,
        dictionaryText,
        dictionaryTruncated: truncated,
      });
      const data = await callGemini({ apiKey, model, prompt, schema: FULL_SCHEMA });
      setAiResult(data);
    } catch (err) {
      setAiError(err.message || String(err));
    } finally {
      setAiRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">AI Normalizer (test tab)</h1>
        <p className="text-base-400 text-sm mt-1 max-w-2xl">
          Runs the same engine as Playground, unchanged. When the engine flags a context issue on a case, you
          can run one dictionary-aware AI call that re-normalizes the whole name — not just the flagged phrase
          — using your live dictionary as context so it reuses existing terms instead of inventing new
          phrasing. Nothing here writes to Supabase.
        </p>
      </div>

      <div className="bg-base-900 border border-base-800 rounded-md p-3 space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-base-400 w-28 shrink-0">Gemini API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => saveApiKey(e.target.value)}
            placeholder="Paste your Google AI Studio key — stored only in this browser"
            className="flex-1 bg-base-950 border border-base-700 rounded px-2 py-1 font-mono"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-base-400 w-28 shrink-0">Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="bg-base-950 border border-base-700 rounded px-2 py-1">
            {MODEL_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div className="text-base-500">
          {dict ? `${dict.lookup.size} dictionary terms loaded — sent as context whenever full AI normalization runs.` : "Loading dictionary…"}
        </div>
      </div>

      <div className="flex gap-3">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run(); }}
          placeholder="Paste raw room name with a known conflict/context issue"
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

      {dictError && <div className="text-red-400 text-sm">Dictionary load failed: {dictError}</div>}
      {runError && <div className="text-red-400 text-sm">{runError}</div>}

      {result && (
        <div className="space-y-4">
          <div className="bg-base-900 border border-base-800 rounded-md p-3 text-sky-400 font-medium">
            {result.canonical_string}
          </div>

          {issues.length === 0 ? (
            <div className="text-sm text-green-400">No context issues flagged on this case — nothing for AI to help with.</div>
          ) : (
            <div className="space-y-3">
              <div className="bg-amber-950/40 border border-amber-800 rounded-md p-3 space-y-1.5">
                <div className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
                  {issues.length} context issue{issues.length === 1 ? "" : "s"} flagged
                </div>
                {issues.map((iss, i) => (
                  <div key={i} className="text-xs text-amber-200">
                    <span className="font-semibold">{ISSUE_LABELS[iss.kind] || iss.kind}</span> — "{iss.token}": {iss.explanation}
                  </div>
                ))}
                <button
                  onClick={runFullAi}
                  disabled={aiRunning}
                  className="mt-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-base-700 rounded-md text-xs font-semibold"
                >
                  {aiRunning ? "Running full AI normalization…" : "Run full AI normalization"}
                </button>
              </div>

              {aiError && <div className="text-red-400 text-xs">{aiError}</div>}

              {aiResult && (
                <div className="space-y-3">
                  <div className="bg-base-900 border border-blue-800 rounded-md p-3 text-blue-300 font-medium">
                    {aiResult.canonical_string}
                  </div>

                  <div className="bg-base-900 border border-base-800 rounded-md divide-y divide-base-800">
                    <div className="grid grid-cols-[100px_1fr_1fr] gap-2 px-3 py-1.5 text-xs uppercase tracking-wide text-base-500 font-semibold">
                      <span></span><span>Engine</span><span>AI</span>
                    </div>
                    <ComponentRow label="class" engineVal={result.parsed_components.class} aiVal={aiResult.class} />
                    <ComponentRow label="occupancy" engineVal={result.parsed_components.occupancy} aiVal={aiResult.occupancy?.join(", ") || null} />
                    <ComponentRow label="type" engineVal={result.parsed_components.type} aiVal={aiResult.type} />
                    <ComponentRow label="bedroom" engineVal={result.parsed_components.bedroom} aiVal={aiResult.bedroom} />
                    <ComponentRow label="bedding" engineVal={result.parsed_components.bedding} aiVal={aiResult.bedding} />
                    <ComponentRow label="view" engineVal={result.parsed_components.view} aiVal={aiResult.view} />
                    <ComponentRow label="building" engineVal={result.parsed_components.building} aiVal={aiResult.building} />
                    <ComponentRow label="accessibility" engineVal={result.parsed_components.accessibility} aiVal={aiResult.accessibility} />
                    <ComponentRow label="other" engineVal={result.parsed_components.other} aiVal={aiResult.other} />
                  </div>

                  {aiResult.notes && (
                    <div className="text-xs text-base-400 italic">AI notes: {aiResult.notes}</div>
                  )}

                  {aiResult.new_terms?.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs uppercase tracking-wide text-base-400 font-semibold">
                        New terms AI didn't find in the dictionary ({aiResult.new_terms.length})
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {aiResult.new_terms.map((nt, i) => (
                          <div key={i} className="bg-base-900 border border-base-800 rounded-md p-3 space-y-1.5 text-xs">
                            <div className="font-mono text-yellow-200">{nt.phrase}</div>
                            <div className="flex justify-between"><span className="text-base-400">Category</span><span className="font-semibold">{nt.category}</span></div>
                            <div className="flex justify-between"><span className="text-base-400">Canonical term</span><span className="font-semibold">{nt.canonical_term}</span></div>
                            <div className="flex justify-between">
                              <span className="text-base-400">Confidence</span>
                              <span className={nt.confidence >= 0.75 ? "text-green-400" : nt.confidence >= 0.5 ? "text-yellow-300" : "text-red-400"}>
                                {Math.round(nt.confidence * 100)}%
                              </span>
                            </div>
                            <div className="text-base-400 italic">"{nt.reasoning}"</div>
                            {nt.category === "NOISE" ? (
                              <div className="text-base-500 pt-1">Flagged as noise — not a dictionary candidate.</div>
                            ) : (
                              <Link
                                to={`/dictionary?newSynonym=${encodeURIComponent(nt.phrase)}&category=${encodeURIComponent(nt.category)}&canonical=${encodeURIComponent(nt.canonical_term)}`}
                                className="inline-block mt-1 text-sky-400 hover:text-sky-300 underline"
                              >
                                Review &amp; add to dictionary →
                              </Link>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
