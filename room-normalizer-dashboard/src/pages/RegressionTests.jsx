import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useDictionary } from "../engine/useDictionary";
import { runRegressionSuite } from "../engine/regression";

function FieldDiffRow({ d }) {
  const fmt = (v) => (v === null || v === undefined ? "—" : Array.isArray(v) ? v.join(", ") : String(v));
  if (d.match) {
    return (
      <div className="flex justify-between px-3 py-1 text-xs">
        <span className="text-base-400 capitalize">{d.field}</span>
        <span className="text-base-200">{fmt(d.expected)}</span>
      </div>
    );
  }
  return (
    <div className="flex justify-between px-3 py-1 text-xs bg-red-950/40">
      <span className="text-red-300 capitalize font-semibold">{d.field}</span>
      <span className="text-right">
        <span className="text-red-300 line-through mr-2">{fmt(d.expected)}</span>
        <span className="text-red-100 font-semibold">{fmt(d.actual)}</span>
      </span>
    </div>
  );
}

function CaseCard({ r }) {
  const [open, setOpen] = useState(!r.passed);
  return (
    <div className={`border rounded-md overflow-hidden ${r.passed ? "border-base-800" : "border-red-800"}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex justify-between items-center px-3 py-2 text-left text-sm ${
          r.passed ? "bg-base-900 hover:bg-base-800" : "bg-red-950/60 hover:bg-red-950"
        }`}
      >
        <span className="flex items-center gap-2">
          <span className={r.passed ? "text-green-400" : "text-red-400"}>{r.passed ? "✓" : "✗"}</span>
          <span className="font-mono">{r.raw_name}</span>
        </span>
        <span className="text-xs text-base-400">#{r.id}</span>
      </button>
      {open && (
        <div className="divide-y divide-base-800 bg-base-950">
          {r.error ? (
            <div className="px-3 py-2 text-xs text-red-400">Engine threw: {r.error}</div>
          ) : (
            r.diff.map((d) => <FieldDiffRow key={d.field} d={d} />)
          )}
        </div>
      )}
    </div>
  );
}

export default function RegressionTests() {
  const { dict, loading: dictLoading, error: dictError } = useDictionary();
  const [goldenCases, setGoldenCases] = useState(null);
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState("all"); // all | failed

  async function loadGoldenCases() {
    const { data, error } = await supabase.from("golden_dataset").select("*").order("id");
    if (!error) setGoldenCases(data);
  }

  useEffect(() => {
    loadGoldenCases();
  }, []);

  async function runAll() {
    if (!dict || !goldenCases?.length) return;
    setRunning(true);
    const r = await runRegressionSuite(goldenCases, dict);
    setResults(r);
    setRunning(false);

    // Write last_run_* back so Dictionary Manager / anyone glancing at the
    // table can see suite health without opening this page.
    for (const item of r) {
      await supabase
        .from("golden_dataset")
        .update({
          last_run_status: item.passed ? "passed" : "failed",
          last_run_result: item.actual,
          last_run_diff: item.diff.filter((d) => !d.match),
          last_run_at: new Date().toISOString(),
        })
        .eq("id", item.id);
    }
  }

  const passCount = results?.filter((r) => r.passed).length ?? null;
  const failCount = results?.filter((r) => !r.passed).length ?? null;
  const shown = results?.filter((r) => filter === "all" || !r.passed) ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Regression Tests</h1>
        <p className="text-base-400 text-sm mt-1">
          Runs every golden case against the live dictionary and diffs the output field by field.
        </p>
      </div>

      <div className="flex items-center gap-3 text-xs text-base-400">
        {dictLoading && <span>Loading dictionary…</span>}
        {dictError && <span className="text-red-400">Dictionary load failed: {dictError}</span>}
        {dict && <span>{dict.lookup.size} dictionary terms</span>}
        <span>·</span>
        <span>{goldenCases ? `${goldenCases.length} golden cases` : "Loading golden cases…"}</span>
      </div>

      {goldenCases && goldenCases.length < 10 && (
        <div className="text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded-md px-3 py-2">
          Only {goldenCases.length} golden case{goldenCases.length === 1 ? "" : "s"} recorded. The fewer you have,
          the less this suite can catch — keep adding cases from the Playground as you fix things.
        </div>
      )}

      <button
        onClick={runAll}
        disabled={running || !dict || !goldenCases?.length}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-base-700 rounded-md font-semibold text-sm"
      >
        {running ? "Running…" : "Run all"}
      </button>

      {results && (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <span className="text-green-400 font-semibold text-sm">{passCount} passed</span>
            <span className="text-red-400 font-semibold text-sm">{failCount} failed</span>
            <div className="flex-1" />
            <div className="flex gap-1 text-xs">
              <button
                onClick={() => setFilter("all")}
                className={`px-2 py-1 rounded ${filter === "all" ? "bg-base-700" : "text-base-400 hover:text-base-50"}`}
              >
                All
              </button>
              <button
                onClick={() => setFilter("failed")}
                className={`px-2 py-1 rounded ${filter === "failed" ? "bg-base-700" : "text-base-400 hover:text-base-50"}`}
              >
                Failed only
              </button>
            </div>
          </div>
          <div className="space-y-2">
            {shown.map((r) => <CaseCard key={r.id} r={r} />)}
          </div>
        </div>
      )}
    </div>
  );
}
