import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useDictionary } from "../engine/useDictionary";
import { normalizeCore } from "../engine/normalizerEngine";
import InvestigationPanel from "./InvestigationPanel.jsx";

const KIND_LABELS = {
  UNRESOLVED: { label: "Unresolved", color: "text-yellow-300 bg-yellow-950 border-yellow-800" },
  AMBIGUOUS_DROP: { label: "Ambiguous drop", color: "text-orange-300 bg-orange-950 border-orange-800" },
  UNPAIRED_SEMANTIC: { label: "Unpaired semantic", color: "text-blue-300 bg-blue-950 border-blue-800" },
  MANUAL_REVIEW: { label: "Manual flag", color: "text-purple-300 bg-purple-950 border-purple-800" },
  CONFLICTING_BEDDING: { label: "Conflicting bedding", color: "text-red-300 bg-red-950 border-red-800" },
};

const INVESTIGATION_BADGE = {
  NEW: null, // default state, no badge needed
  INVESTIGATING: "text-sky-300 bg-sky-950 border-sky-800",
  ROOT_CAUSE_IDENTIFIED: "text-indigo-300 bg-indigo-950 border-indigo-800",
  FIXED: "text-green-300 bg-green-950 border-green-800",
  REGRESSION_ADDED: "text-emerald-300 bg-emerald-950 border-emerald-800",
  IGNORED: "text-base-400 bg-base-800 border-base-700",
};

function AttachPicker({ row, dictRows, onAttach, onCancel, busy }) {
  const [query, setQuery] = useState(row.token);
  const [selected, setSelected] = useState(null);
  const [addSynonym, setAddSynonym] = useState(true);

  const matches = useMemo(() => {
    if (!dictRows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return dictRows
      .filter((r) => r.synonyms.toLowerCase().includes(q) || (r.canonical_term || "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [dictRows, query]);

  return (
    <div className="bg-base-950 border border-base-700 rounded-md p-3 mt-2 space-y-2">
      <input
        autoFocus
        value={query}
        onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
        placeholder="Search dictionary terms…"
        className="w-full bg-base-900 border border-base-700 rounded-md px-2 py-1.5 text-sm"
      />
      {matches.length > 0 && (
        <div className="max-h-40 overflow-auto space-y-1">
          {matches.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r)}
              className={`w-full text-left px-2 py-1.5 rounded text-xs ${
                selected?.id === r.id ? "bg-blue-600" : "bg-base-900 hover:bg-base-800"
              }`}
            >
              <span className="font-semibold">{r.canonical_term || "(delete/noise)"}</span>
              <span className="text-base-400"> · {r.category} · #{r.id} · {r.synonyms}</span>
            </button>
          ))}
        </div>
      )}
      {selected && (
        <label className="flex items-center gap-2 text-xs text-base-300">
          <input type="checkbox" checked={addSynonym} onChange={(e) => setAddSynonym(e.target.checked)} />
          Add "{row.token}" as a synonym on this term
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1 text-xs text-base-400 hover:text-base-50">Cancel</button>
        <button
          disabled={!selected || busy}
          onClick={() => onAttach(selected.id, addSynonym ? row.token : null)}
          className="px-3 py-1 bg-green-700 hover:bg-green-600 disabled:bg-base-700 rounded text-xs font-semibold"
        >
          {busy ? "Attaching…" : "Attach"}
        </button>
      </div>
    </div>
  );
}

function QueueRow({ row, dict, dictRows, onResolved, onInvestigate }) {
  const [attaching, setAttaching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [rechecking, setRechecking] = useState(false);
  const [recheckResults, setRecheckResults] = useState(null);
  const kindCfg = KIND_LABELS[row.kind] || { label: row.kind, color: "text-base-300 bg-base-800 border-base-700" };
  const invBadge = INVESTIGATION_BADGE[row.investigation_status];

  async function recheck() {
    if (!dict || !row.sample_raw_names?.length) return;
    setRechecking(true);
    setErr(null);
    const out = [];
    for (const raw of row.sample_raw_names) {
      try {
        const r = await normalizeCore(raw, dict, { trace: false, diagnostics: false });
        const stillFlagged = (r.diagnostics || []).some(
          (d) => d.kind === row.kind && d.token === row.token && (!row.diagnostic_code || d.code === row.diagnostic_code)
        );
        out.push({ raw, stillFlagged, canonical: r.canonical_string });
      } catch (e) {
        out.push({ raw, stillFlagged: true, error: e.message });
      }
    }
    setRecheckResults(out);
    setRechecking(false);
  }

  async function markVerifiedFixed() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc("resolve_review_queue_item", { p_review_id: row.id, p_action: "verify_fixed" });
    setBusy(false);
    if (error) setErr(error.message);
    else onResolved(row.id);
  }

  async function ignore() {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc("resolve_review_queue_item", { p_review_id: row.id, p_action: "ignore" });
    setBusy(false);
    if (error) setErr(error.message);
    else onResolved(row.id);
  }

  async function attach(termId, newSynonym) {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc("resolve_review_queue_item", {
      p_review_id: row.id,
      p_action: "attach",
      p_term_id: termId,
      p_new_synonym: newSynonym,
    });
    setBusy(false);
    if (error) setErr(error.message);
    else onResolved(row.id);
  }

  return (
    <div className="border border-base-800 rounded-md p-3">
      <div className="flex justify-between items-start gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono font-semibold text-base-50">{row.token}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded border ${kindCfg.color}`}>{kindCfg.label}</span>
            {row.diagnostic_code && <span className="text-xs text-base-500">{row.diagnostic_code}</span>}
            {invBadge && (
              <span className={`text-xs px-1.5 py-0.5 rounded border ${invBadge}`}>{row.investigation_status.replace(/_/g, " ")}</span>
            )}
          </div>
          <div className="text-xs text-base-400">
            {row.occurrence_count}× · last seen {new Date(row.last_seen).toLocaleDateString()}
          </div>
          {row.explanation && <div className="text-xs text-base-400 mt-1 italic">{row.explanation}</div>}
          {row.sample_raw_names?.length > 0 && (
            <div className="text-xs text-base-500 mt-1 font-mono">
              e.g. {row.sample_raw_names.slice(0, 3).join(" · ")}
            </div>
          )}
        </div>
        <div className="flex gap-2 whitespace-nowrap">
          <button
            onClick={() => onInvestigate(row)}
            className="text-xs px-2 py-1 bg-indigo-700 hover:bg-indigo-600 rounded font-semibold"
          >
            Investigate
          </button>
          <button
            onClick={recheck}
            disabled={rechecking || !row.sample_raw_names?.length}
            className="text-xs px-2 py-1 bg-sky-700 hover:bg-sky-600 disabled:bg-base-700 rounded font-semibold"
            title={!row.sample_raw_names?.length ? "No sample raw names stored for this row" : "Re-run stored samples against the live dictionary"}
          >
            {rechecking ? "Checking…" : "Recheck"}
          </button>
          <button onClick={() => setAttaching((a) => !a)} className="text-xs px-2 py-1 bg-green-700 hover:bg-green-600 rounded font-semibold">
            Attach
          </button>
          <Link
            to={`/dictionary?newSynonym=${encodeURIComponent(row.token)}`}
            className="text-xs px-2 py-1 bg-blue-700 hover:bg-blue-600 rounded font-semibold"
          >
            New term
          </Link>
          <button onClick={ignore} disabled={busy} className="text-xs px-2 py-1 bg-base-800 hover:bg-base-700 rounded font-semibold text-base-300">
            Ignore
          </button>
        </div>
      </div>
      {err && <div className="text-red-400 text-xs mt-2">{err}</div>}
      {recheckResults && (
        <div className="bg-base-950 border border-base-700 rounded-md p-3 mt-2 space-y-2">
          <div className="text-xs text-base-400">
            Re-ran the {recheckResults.length} stored sample{recheckResults.length === 1 ? "" : "s"} against the live dictionary:
          </div>
          <div className="space-y-1">
            {recheckResults.map((r, i) => (
              <div key={i} className="text-xs font-mono flex items-start gap-2">
                <span className={r.stillFlagged ? "text-red-400" : "text-green-400"}>{r.stillFlagged ? "✗" : "✓"}</span>
                <span className="text-base-300">{r.raw}</span>
                {!r.stillFlagged && r.canonical && <span className="text-base-500">→ {r.canonical}</span>}
                {r.error && <span className="text-red-400">error: {r.error}</span>}
              </div>
            ))}
          </div>
          {recheckResults.every((r) => !r.stillFlagged) ? (
            <div className="pt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-green-400">All stored samples now resolve cleanly.</span>
                <button
                  onClick={markVerifiedFixed}
                  disabled={busy}
                  className="text-xs px-2 py-1 bg-green-700 hover:bg-green-600 disabled:bg-base-700 rounded font-semibold"
                >
                  {busy ? "Marking…" : "Mark resolved (verified fixed)"}
                </button>
              </div>
              <div className="text-xs text-base-500 italic mt-1">
                Based on {recheckResults.length} of {row.occurrence_count} real occurrences — not a guarantee every case is fixed.
              </div>
            </div>
          ) : (
            <div className="text-xs text-red-400 pt-1">
              Still flagged on {recheckResults.filter((r) => r.stillFlagged).length} of {recheckResults.length} samples — not fully fixed yet.
              Note: this only checks the {recheckResults.length} stored samples, not all {row.occurrence_count} real occurrences.
            </div>
          )}
        </div>
      )}
      {attaching && (
        <AttachPicker row={row} dictRows={dictRows} busy={busy} onCancel={() => setAttaching(false)} onAttach={attach} />
      )}
    </div>
  );
}

function ClusterView({ items }) {
  const clusters = useMemo(() => {
    const map = new Map();
    for (const r of items) {
      const key = `${r.kind}|${r.diagnostic_code || ""}`;
      const c = map.get(key) || { kind: r.kind, diagnostic_code: r.diagnostic_code, count: 0, totalOccurrences: 0, examples: [] };
      c.count += 1;
      c.totalOccurrences += r.occurrence_count;
      if (c.examples.length < 3) c.examples.push(r.token);
      map.set(key, c);
    }
    return [...map.values()].sort((a, b) => b.totalOccurrences - a.totalOccurrences);
  }, [items]);

  return (
    <div className="space-y-2">
      {clusters.map((c) => {
        const kindCfg = KIND_LABELS[c.kind] || { label: c.kind, color: "text-base-300 bg-base-800 border-base-700" };
        return (
          <div key={`${c.kind}|${c.diagnostic_code}`} className="border border-base-800 rounded-md p-3 flex justify-between items-center">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs px-1.5 py-0.5 rounded border ${kindCfg.color}`}>{kindCfg.label}</span>
                {c.diagnostic_code && <span className="text-xs text-base-500">{c.diagnostic_code}</span>}
              </div>
              <div className="text-xs text-base-500 font-mono">e.g. {c.examples.join(" · ")}</div>
            </div>
            <div className="text-right text-xs text-base-400">
              <div>{c.count} distinct case{c.count === 1 ? "" : "s"}</div>
              <div>{c.totalOccurrences} total occurrences</div>
            </div>
          </div>
        );
      })}
      {clusters.length === 0 && (
        <div className="text-center text-base-500 text-sm py-8 border border-dashed border-base-800 rounded-md">
          Nothing to cluster.
        </div>
      )}
    </div>
  );
}

export default function ReviewQueue() {
  const { rows: dictRows, dict } = useDictionary();
  const [items, setItems] = useState(null);
  const [kindFilter, setKindFilter] = useState("ALL");
  const [error, setError] = useState(null);
  const [view, setView] = useState("list"); // "list" | "cluster"
  const [investigating, setInvestigating] = useState(null); // the row currently open in the investigation panel

  async function load() {
    const { data, error: dbError } = await supabase
      .from("review_queue")
      .select("*")
      .eq("status", "pending")
      .order("occurrence_count", { ascending: false })
      .order("last_seen", { ascending: false });
    if (dbError) setError(dbError.message);
    else setItems(data);
  }

  useEffect(() => {
    load();
  }, []);

  function handleResolved(id) {
    setItems((prev) => prev.filter((r) => r.id !== id));
  }

  function handleInvestigationSaved(id, patch) {
    setItems((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  const filtered = items?.filter((r) => kindFilter === "ALL" || r.kind === kindFilter) ?? [];
  const kinds = ["ALL", ...Object.keys(KIND_LABELS)];

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-lg font-semibold">Review Queue</h1>
          <p className="text-base-400 text-sm mt-1">
            Tokens the engine couldn't confidently resolve, sorted by how often they show up. Attach to an existing
            dictionary term, create a new one, ignore, or open Investigate for a deeper structural look.
          </p>
        </div>
        <div className="flex gap-1 text-xs bg-base-900 border border-base-800 rounded-md p-0.5">
          <button
            onClick={() => setView("list")}
            className={`px-2 py-1 rounded ${view === "list" ? "bg-base-700" : "text-base-400 hover:text-base-50"}`}
          >
            List
          </button>
          <button
            onClick={() => setView("cluster")}
            className={`px-2 py-1 rounded ${view === "cluster" ? "bg-base-700" : "text-base-400 hover:text-base-50"}`}
          >
            Cluster view
          </button>
        </div>
      </div>

      {error && <div className="text-red-400 text-sm">{error}</div>}

      <div className="flex gap-1 text-xs">
        {kinds.map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            className={`px-2 py-1 rounded ${kindFilter === k ? "bg-base-700" : "text-base-400 hover:text-base-50"}`}
          >
            {k === "ALL" ? "All" : KIND_LABELS[k].label}
          </button>
        ))}
        <span className="ml-auto text-base-400 self-center">
          {items ? `${filtered.length} pending` : "Loading…"}
        </span>
      </div>

      {view === "cluster" ? (
        <ClusterView items={filtered} />
      ) : (
        <div className="space-y-2">
          {filtered.map((row) => (
            <QueueRow key={row.id} row={row} dict={dict} dictRows={dictRows} onResolved={handleResolved} onInvestigate={setInvestigating} />
          ))}
          {items && filtered.length === 0 && (
            <div className="text-center text-base-500 text-sm py-8 border border-dashed border-base-800 rounded-md">
              Queue's clear.
            </div>
          )}
        </div>
      )}

      {investigating && (
        <InvestigationPanel
          row={investigating}
          dict={dict}
          onClose={() => setInvestigating(null)}
          onInvestigationSaved={handleInvestigationSaved}
        />
      )}
    </div>
  );
}
