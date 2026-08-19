import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useDictionary } from "../engine/useDictionary";
import InvestigationPanel from "./InvestigationPanel.jsx";

const KIND_LABELS = {
  UNRESOLVED: { label: "Unresolved", color: "text-yellow-300 bg-yellow-950 border-yellow-800" },
  AMBIGUOUS_DROP: { label: "Ambiguous drop", color: "text-orange-300 bg-orange-950 border-orange-800" },
  UNPAIRED_SEMANTIC: { label: "Unpaired semantic", color: "text-blue-300 bg-blue-950 border-blue-800" },
  MANUAL_REVIEW: { label: "Manual flag", color: "text-purple-300 bg-purple-950 border-purple-800" },
  CONFLICTING_BEDDING: { label: "Conflicting bedding", color: "text-red-300 bg-red-950 border-red-800" },
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
              <span className="text-base-400"> · {r.category} · #{r.id}</span>
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

function QueueRow({ row, dictRows, onResolved, onInvestigate }) {
  const [attaching, setAttaching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const kindCfg = KIND_LABELS[row.kind] || { label: row.kind, color: "text-base-300 bg-base-800 border-base-700" };

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
    <div className="border border-base-800 rounded-md px-3 py-2.5">
      <div className="flex justify-between items-center gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-base-50">{row.token}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded border ${kindCfg.color}`}>{kindCfg.label}</span>
            <span className="text-xs text-base-500">{row.occurrence_count}×</span>
          </div>
          {row.sample_raw_names?.[0] && (
            <div className="text-xs text-base-500 mt-0.5 font-mono truncate">{row.sample_raw_names[0]}</div>
          )}
        </div>
        <div className="flex gap-1.5 whitespace-nowrap">
          <button onClick={() => onInvestigate(row)} className="text-xs px-2 py-1 bg-base-800 hover:bg-base-700 rounded text-base-200">
            Investigate
          </button>
          <button onClick={() => setAttaching((a) => !a)} className="text-xs px-2 py-1 bg-base-800 hover:bg-base-700 rounded text-base-200">
            Attach
          </button>
          <Link to={`/dictionary?newSynonym=${encodeURIComponent(row.token)}`} className="text-xs px-2 py-1 bg-base-800 hover:bg-base-700 rounded text-base-200">
            New term
          </Link>
          <button onClick={ignore} disabled={busy} className="text-xs px-2 py-1 text-base-500 hover:text-base-300">
            Ignore
          </button>
        </div>
      </div>
      {err && <div className="text-red-400 text-xs mt-2">{err}</div>}
      {attaching && (
        <AttachPicker row={row} dictRows={dictRows} busy={busy} onCancel={() => setAttaching(false)} onAttach={attach} />
      )}
    </div>
  );
}

export default function ReviewQueue() {
  const { rows: dictRows, dict } = useDictionary();
  const [items, setItems] = useState(null);
  const [kindFilter, setKindFilter] = useState("ALL");
  const [error, setError] = useState(null);
  const [investigating, setInvestigating] = useState(null);

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

  const filtered = items?.filter((r) => kindFilter === "ALL" || r.kind === kindFilter) ?? [];
  const kinds = ["ALL", ...Object.keys(KIND_LABELS)];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Review Queue</h1>
        <p className="text-base-400 text-sm mt-1">
          Sorted by how often each item shows up. Attach to an existing term, create a new one, ignore, or Investigate for a closer look.
        </p>
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

      <div className="space-y-1.5">
        {filtered.map((row) => (
          <QueueRow key={row.id} row={row} dictRows={dictRows} onResolved={handleResolved} onInvestigate={setInvestigating} />
        ))}
        {items && filtered.length === 0 && (
          <div className="text-center text-base-500 text-sm py-8 border border-dashed border-base-800 rounded-md">
            Queue's clear.
          </div>
        )}
      </div>

      {investigating && (
        <InvestigationPanel row={investigating} dict={dict} onClose={() => setInvestigating(null)} />
      )}
    </div>
  );
}
