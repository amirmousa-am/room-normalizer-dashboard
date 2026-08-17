import { useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useDictionary } from "../engine/useDictionary";
import { normalizeCore, createCollector } from "../engine/normalizerEngine";

const CHUNK_SIZE = 200; // yield to the UI thread between chunks so large pastes don't freeze the tab

function parseInput(raw) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function toCsv(rows) {
  const header = ["raw_name", "canonical_string", "canonical_hash", "class", "occupancy", "type", "bedroom", "bedding", "view", "building", "amenity", "conditional", "custom", "status", "error"];
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    const pc = r.result?.parsed_components || {};
    const arr = (v) => (Array.isArray(v) ? v.join(" | ") : v ?? "");
    lines.push(
      [
        r.raw,
        r.result?.canonical_string ?? "",
        r.result?.canonical_hash ?? "",
        arr(pc.class),
        pc.occupancy ?? "",
        arr(pc.type),
        pc.bedroom ?? "",
        pc.bedding ?? "",
        pc.view ?? "",
        arr(pc.building),
        arr(pc.amenity),
        arr(pc.conditional),
        arr(pc.custom),
        r.error ? "error" : "ok",
        r.error ?? "",
      ]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\n");
}

export default function BulkTranslator() {
  const { dict, loading, error: dictError, reload } = useDictionary();
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState(null); // [{ raw, result, error, diagnosticsCount }]
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [collecting, setCollecting] = useState(false);
  const [collectStatus, setCollectStatus] = useState(null);
  const [filter, setFilter] = useState("ALL"); // ALL | OK | ERROR | REVIEW
  const cancelRef = useRef(false);
  const fileInputRef = useRef(null);

  const names = useMemo(() => parseInput(raw), [raw]);

  const stats = useMemo(() => {
    if (!rows) return null;
    const ok = rows.filter((r) => !r.error).length;
    const errors = rows.filter((r) => r.error).length;
    const withReview = rows.filter((r) => !r.error && r.diagnosticsCount > 0).length;
    return { total: rows.length, ok, errors, withReview };
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (!rows) return [];
    if (filter === "OK") return rows.filter((r) => !r.error);
    if (filter === "ERROR") return rows.filter((r) => r.error);
    if (filter === "REVIEW") return rows.filter((r) => !r.error && r.diagnosticsCount > 0);
    return rows;
  }, [rows, filter]);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let text = String(reader.result || "");
      // Accept plain .txt (one per line) or a single-column .csv — strip a
      // "raw_name"/"name" header row and surrounding quotes if present.
      const lines = text.split(/\r?\n/);
      if (lines.length && /^"?(raw_name|name|room name)"?$/i.test(lines[0].trim())) {
        lines.shift();
      }
      text = lines.map((l) => l.replace(/^"(.*)"$/, "$1")).join("\n");
      setRaw(text);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function run() {
    if (!names.length || !dict) return;
    setRunning(true);
    setRows([]);
    setCollectStatus(null);
    setProgress({ done: 0, total: names.length });
    cancelRef.current = false;

    const out = [];
    for (let i = 0; i < names.length; i += CHUNK_SIZE) {
      if (cancelRef.current) break;
      const chunk = names.slice(i, i + CHUNK_SIZE);
      for (const name of chunk) {
        try {
          // diagnostics: false — skip the heavy per-token UI trace for bulk
          // runs; diagnostics/rule_hits (used below for review collection)
          // are still populated regardless of this flag.
          const result = await normalizeCore(name, dict, { trace: false, diagnostics: false });
          out.push({ raw: name, result, error: null, diagnosticsCount: (result.diagnostics || []).length });
        } catch (err) {
          out.push({ raw: name, result: null, error: err.message || String(err), diagnosticsCount: 0 });
        }
      }
      setProgress({ done: Math.min(i + CHUNK_SIZE, names.length), total: names.length });
      // yield so the browser can paint / stay responsive on large batches
      await new Promise((r) => setTimeout(r, 0));
    }

    setRows(out);
    setRunning(false);
  }

  function stop() {
    cancelRef.current = true;
  }

  function downloadCsv() {
    if (!rows?.length) return;
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bulk-translation-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function collectToReviewQueue() {
    if (!rows?.length) return;
    setCollecting(true);
    setCollectStatus(null);
    try {
      const collector = createCollector("bulk-translator", supabase);
      let recorded = 0;
      for (const r of rows) {
        if (r.result) {
          collector.recordResult(r.result);
          recorded += 1;
        } else if (r.error) {
          collector.recordError(r.raw, { message: r.error });
        }
      }
      await collector.flush();
      const reviewCount = rows.reduce((n, r) => n + (r.diagnosticsCount || 0), 0);
      setCollectStatus(
        `Collected ${recorded} result${recorded === 1 ? "" : "s"} (${reviewCount} review event${reviewCount === 1 ? "" : "s"}) to the queue.`
      );
    } catch (err) {
      setCollectStatus(`Collection failed: ${err.message || err}`);
    } finally {
      setCollecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Bulk Translator</h1>
        <p className="text-base-400 text-sm mt-1 max-w-2xl">
          Paste or import raw room names (one per line), run them through normalizeCore with diagnostics off, then
          export the results or send everything straight to the Review Queue.
        </p>
      </div>

      <div className="flex items-center gap-3 text-xs text-base-400">
        {loading && <span>Loading dictionary…</span>}
        {dictError && <span className="text-red-400">Dictionary load failed: {dictError}</span>}
        {dict && !loading && <span>{dict.lookup.size} dictionary terms loaded</span>}
        <button onClick={reload} className="underline hover:text-base-50">Refresh dictionary</button>
      </div>

      <div className="space-y-2">
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={"One raw room name per line, e.g.\nDeluxe King Room, City View\nSuperior Twin, 2 Single Beds\n..."}
          className="w-full bg-base-900 border border-base-700 rounded-md p-3 text-sm min-h-[160px] font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-600"
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-base-400">{names.length.toLocaleString()} name{names.length === 1 ? "" : "s"} detected</span>
          <input ref={fileInputRef} type="file" accept=".txt,.csv" onChange={handleFile} className="hidden" />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs px-2 py-1 bg-base-800 hover:bg-base-700 rounded text-base-200"
          >
            Import .txt / .csv
          </button>
          {raw && !running && (
            <button onClick={() => { setRaw(""); setRows(null); }} className="text-xs text-base-500 hover:text-base-300">
              Clear
            </button>
          )}
          <div className="ml-auto flex gap-2">
            {running ? (
              <button onClick={stop} className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded-md font-semibold text-sm">
                Stop
              </button>
            ) : (
              <button
                onClick={run}
                disabled={!names.length || !dict}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-base-700 rounded-md font-semibold text-sm"
              >
                Translate {names.length ? names.length.toLocaleString() : ""}
              </button>
            )}
          </div>
        </div>
        {running && (
          <div className="space-y-1">
            <div className="h-1.5 bg-base-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            <div className="text-xs text-base-400">{progress.done.toLocaleString()} / {progress.total.toLocaleString()} processed</div>
          </div>
        )}
      </div>

      {rows && !running && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 text-xs">
              {[
                ["ALL", `All (${stats.total})`],
                ["OK", `OK (${stats.ok})`],
                ["REVIEW", `Has review events (${stats.withReview})`],
                ["ERROR", `Errors (${stats.errors})`],
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`px-2 py-1 rounded ${filter === key ? "bg-base-700" : "text-base-400 hover:text-base-50"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex gap-2">
              <button
                onClick={downloadCsv}
                disabled={!rows.length}
                className="px-3 py-1.5 bg-base-800 hover:bg-base-700 disabled:opacity-50 rounded-md text-xs font-semibold"
              >
                Export CSV
              </button>
              <button
                onClick={collectToReviewQueue}
                disabled={collecting || !rows.length}
                className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:bg-base-700 rounded-md text-xs font-semibold"
              >
                {collecting ? "Collecting…" : "Collect all to Review Queue"}
              </button>
            </div>
          </div>
          {collectStatus && <div className="text-xs text-base-300">{collectStatus}</div>}

          <div className="border border-base-800 rounded-md overflow-hidden">
            <div className="max-h-[520px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-base-900 sticky top-0">
                  <tr className="text-left text-base-400">
                    <th className="px-3 py-2 font-semibold">Raw name</th>
                    <th className="px-3 py-2 font-semibold">Canonical string</th>
                    <th className="px-3 py-2 font-semibold w-20">Review</th>
                    <th className="px-3 py-2 font-semibold w-20">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base-800">
                  {filteredRows.map((r, i) => (
                    <tr key={i} className="hover:bg-base-900/60">
                      <td className="px-3 py-1.5 font-mono text-base-300 max-w-xs truncate" title={r.raw}>{r.raw}</td>
                      <td className="px-3 py-1.5 text-sky-400 max-w-md truncate" title={r.result?.canonical_string}>
                        {r.error ? <span className="text-red-400">{r.error}</span> : r.result?.canonical_string}
                      </td>
                      <td className="px-3 py-1.5 text-base-400">{r.diagnosticsCount > 0 ? r.diagnosticsCount : "—"}</td>
                      <td className="px-3 py-1.5">
                        {r.error ? (
                          <span className="text-red-400">Error</span>
                        ) : r.diagnosticsCount > 0 ? (
                          <span className="text-yellow-300">Review</span>
                        ) : (
                          <span className="text-green-400">OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredRows.length === 0 && (
                <div className="text-center text-base-500 text-sm py-8">No rows match this filter.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
