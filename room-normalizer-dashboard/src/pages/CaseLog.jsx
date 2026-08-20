import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { normalizeCore } from "../engine/normalizerEngine";
import { useDictionary } from "../engine/useDictionary";
import engineSource from "../engine/normalizerEngine.js?raw";

function buildExportDoc(cases, liveDict, engineSrc) {
  const dictTable = (liveDict || [])
    .map((r) => "| " + r.id + " | " + r.category + " | " + r.action + " | " + (r.canonical_term || "\u2014") + " | " + r.synonyms + " | " + r.priority + " |")
    .join("\n");

  const caseBlocks = (cases || [])
    .map(function (c, i) {
      const lines = [
        "### Case " + (i + 1),
        "- Raw input: `" + c.raw_name + "`",
        "- Actual output: `" + (c.actual_output || "(not captured)") + "`",
        "- Expected output: `" + c.expected_output + "`",
      ];
      if (c.notes) lines.push("- Notes: " + c.notes);
      return lines.join("\n");
    })
    .join("\n\n");

  const parts = [];
  parts.push("# Room Normalizer \u2014 Case Export for AI Review");
  parts.push("Generated: " + new Date().toISOString());
  parts.push("");
  parts.push("This is an export from the Room Normalizer Dashboard's Case Log. It contains:");
  parts.push("1. Room names where the engine's actual output doesn't match what it should produce.");
  parts.push("2. The full current dictionary_terms table.");
  parts.push("3. The full current engine source (normalizerEngine.js \u2014 a ported/extended version of the room-normalizer-panel.user.js Tampermonkey userscript).");
  parts.push("");
  parts.push("Please review the cases against the dictionary and engine source, and recommend the best handling for each \u2014 dictionary gap, structural rule change, or something else. Don't assume every case needs the same kind of fix.");
  parts.push("");
  parts.push("## Problem Cases (" + ((cases && cases.length) || 0) + ")");
  parts.push("");
  parts.push(caseBlocks || "(none logged yet)");
  parts.push("");
  parts.push("## Current Dictionary (dictionary_terms, " + ((liveDict && liveDict.length) || 0) + " rows)");
  parts.push("");
  parts.push("| id | category | action | canonical | synonyms | priority |");
  parts.push("|---|---|---|---|---|---|");
  parts.push(dictTable);
  parts.push("");
  parts.push("## Current Engine Source (normalizerEngine.js)");
  parts.push("");
  parts.push("```js");
  parts.push(engineSrc);
  parts.push("```");
  return parts.join("\n");
}

export default function CaseLog() {
  const { dict } = useDictionary();
  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);

  const [rawName, setRawName] = useState("");
  const [actualOutput, setActualOutput] = useState("");
  const [expectedOutput, setExpectedOutput] = useState("");
  const [notes, setNotes] = useState("");
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function load() {
    const { data, error: dbError } = await supabase
      .from("case_log")
      .select("*")
      .order("created_at", { ascending: false });
    if (dbError) setError(dbError.message);
    else setCases(data);
  }

  useEffect(() => {
    load();
  }, []);

  async function runEngine() {
    if (!rawName.trim() || !dict) return;
    setRunning(true);
    try {
      const r = await normalizeCore(rawName.trim(), dict, { trace: false, diagnostics: false });
      setActualOutput(r.canonical_string);
    } catch (e) {
      setActualOutput("(engine error: " + e.message + ")");
    } finally {
      setRunning(false);
    }
  }

  async function addCase() {
    if (!rawName.trim() || !expectedOutput.trim()) return;
    setSaving(true);
    const { error: dbError } = await supabase.from("case_log").insert({
      raw_name: rawName.trim(),
      actual_output: actualOutput.trim() || null,
      expected_output: expectedOutput.trim(),
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (!dbError) {
      setRawName("");
      setActualOutput("");
      setExpectedOutput("");
      setNotes("");
      load();
    } else {
      setError(dbError.message);
    }
  }

  async function deleteCase(id) {
    await supabase.from("case_log").delete().eq("id", id);
    setCases((prev) => prev.filter((c) => c.id !== id));
  }

  async function exportForAI() {
    setExporting(true);
    try {
      const { data: liveDict } = await supabase
        .from("dictionary_terms")
        .select("id,synonyms,canonical_term,category,action,priority,output_bucket,trigger_bucket")
        .order("priority")
        .order("id");

      const doc = buildExportDoc(cases, liveDict, engineSource);

      const blob = new Blob([doc], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "room-normalizer-case-export-" + new Date().toISOString().slice(0, 10) + ".md";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Case Log</h1>
        <p className="text-base-400 text-sm mt-1">
          Collect "this translated wrong, here's what it should be" cases as you find them. Export the whole
          set — cases, dictionary, and engine source — as one file to hand to an AI for a recommendation.
        </p>
      </div>

      {error && <div className="text-red-400 text-sm">{error}</div>}

      <div className="bg-base-900 border border-base-800 rounded-md p-4 space-y-3">
        <div className="flex gap-2">
          <input
            value={rawName}
            onChange={(e) => setRawName(e.target.value)}
            placeholder="Raw room name"
            className="flex-1 bg-base-950 border border-base-700 rounded-md px-3 py-1.5 text-sm"
          />
          <button
            onClick={runEngine}
            disabled={running || !rawName.trim() || !dict}
            className="px-3 py-1.5 bg-base-800 hover:bg-base-700 disabled:opacity-50 rounded-md text-sm whitespace-nowrap"
          >
            {running ? "Running…" : "Run engine"}
          </button>
        </div>
        <div>
          <label className="text-xs text-base-400">Actual (auto-filled by "Run engine", editable)</label>
          <input
            value={actualOutput}
            onChange={(e) => setActualOutput(e.target.value)}
            className="mt-1 w-full bg-base-950 border border-base-700 rounded-md px-3 py-1.5 text-sm font-mono"
          />
        </div>
        <div>
          <label className="text-xs text-base-400">Expected — what it should say</label>
          <input
            value={expectedOutput}
            onChange={(e) => setExpectedOutput(e.target.value)}
            className="mt-1 w-full bg-base-950 border border-base-700 rounded-md px-3 py-1.5 text-sm font-mono"
          />
        </div>
        <div>
          <label className="text-xs text-base-400">Notes (optional — the problem, or how common this pattern is)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full bg-base-950 border border-base-700 rounded-md px-3 py-1.5 text-sm min-h-[50px]"
          />
        </div>
        <button
          onClick={addCase}
          disabled={saving || !rawName.trim() || !expectedOutput.trim()}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-base-700 rounded-md text-sm font-semibold"
        >
          {saving ? "Adding…" : "Add case"}
        </button>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-sm text-base-400">{cases ? cases.length + " case" + (cases.length === 1 ? "" : "s") + " logged" : "Loading…"}</span>
        <button
          onClick={exportForAI}
          disabled={exporting || !cases?.length}
          className="px-4 py-1.5 bg-green-700 hover:bg-green-600 disabled:bg-base-700 rounded-md text-sm font-semibold"
        >
          {exporting ? "Building export…" : "Export for AI"}
        </button>
      </div>

      <div className="space-y-1.5">
        {(cases || []).map((c) => (
          <div key={c.id} className="border border-base-800 rounded-md px-3 py-2.5 flex justify-between items-start gap-3">
            <div className="min-w-0 text-sm">
              <div className="font-mono text-base-50 truncate">{c.raw_name}</div>
              <div className="text-xs text-base-500 mt-0.5">
                <span className="text-red-400">actual:</span> {c.actual_output || "—"}
              </div>
              <div className="text-xs text-base-500">
                <span className="text-green-400">expected:</span> {c.expected_output}
              </div>
              {c.notes && <div className="text-xs text-base-600 italic mt-0.5">{c.notes}</div>}
            </div>
            <button onClick={() => deleteCase(c.id)} className="text-xs text-base-500 hover:text-red-400 whitespace-nowrap">
              Delete
            </button>
          </div>
        ))}
        {cases && cases.length === 0 && (
          <div className="text-center text-base-500 text-sm py-8 border border-dashed border-base-800 rounded-md">
            No cases logged yet.
          </div>
        )}
      </div>
    </div>
  );
}
