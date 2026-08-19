import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useDictionary } from "../engine/useDictionary";
import { buildLookup, DICTIONARY_CATEGORIES, DICTIONARY_ACTIONS, OUTPUT_BUCKETS, TRIGGER_BUCKETS } from "../engine/normalizerEngine";
import { runRegressionSuite } from "../engine/regression";

const OUTPUT_BUCKET_CATEGORIES = new Set(["AMENITY", "PRIVILEGE", "CONDITIONAL", "NOISE"]);

const EMPTY_FORM = { id: null, synonyms: "", canonical_term: "", category: "AMENITY", action: "REPLACE", priority: 100, output_bucket: "", trigger_bucket: "" };

function rowToForm(row) {
  return {
    id: row.id,
    synonyms: row.synonyms,
    canonical_term: row.canonical_term || "",
    category: row.category,
    action: row.action,
    priority: row.priority,
    output_bucket: row.output_bucket || "",
    trigger_bucket: row.trigger_bucket || "",
  };
}

export default function DictionaryManager() {
  const { rows, dict, loading, error, reload } = useDictionary();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [form, setForm] = useState(null); // null = form closed
  const [pendingDelete, setPendingDelete] = useState(null);
  const [checking, setChecking] = useState(false);
  const [blockedResults, setBlockedResults] = useState(null); // failed regression results, if any
  const [saveError, setSaveError] = useState(null);
  const [goldenCount, setGoldenCount] = useState(null);

  useEffect(() => {
    supabase
      .from("golden_dataset")
      .select("id", { count: "exact", head: true })
      .then(({ count }) => setGoldenCount(count ?? 0));
  }, []);

  // Deep link from Playground: /dictionary?term=ID
  useEffect(() => {
    const termId = searchParams.get("term");
    if (termId && rows) {
      const row = rows.find((r) => String(r.id) === termId);
      if (row) {
        setForm(rowToForm(row));
        setCategoryFilter("ALL");
      }
    }
  }, [searchParams, rows]);

  // Deep link from Review Queue / AI Normalizer:
  // /dictionary?newSynonym=token&category=AMENITY&canonical=Free%20WiFi
  // opens the "new term" form pre-filled. category/canonical are optional —
  // Review Queue only ever sent newSynonym, AI Normalizer sends all three.
  useEffect(() => {
    const newSynonym = searchParams.get("newSynonym");
    if (newSynonym) {
      const category = searchParams.get("category");
      const canonical = searchParams.get("canonical");
      setForm({
        ...EMPTY_FORM,
        synonyms: newSynonym,
        canonical_term: canonical || newSynonym,
        category: DICTIONARY_CATEGORIES.includes(category) ? category : EMPTY_FORM.category,
      });
    }
  }, [searchParams]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (categoryFilter !== "ALL" && r.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        r.synonyms.toLowerCase().includes(q) ||
        (r.canonical_term || "").toLowerCase().includes(q) ||
        String(r.id) === q
      );
    });
  }, [rows, search, categoryFilter]);

  function openNew() {
    setForm({ ...EMPTY_FORM });
    setBlockedResults(null);
    setSaveError(null);
  }

  function openEdit(row) {
    setForm(rowToForm(row));
    setBlockedResults(null);
    setSaveError(null);
  }

  function closeForm() {
    setForm(null);
    setBlockedResults(null);
    setSaveError(null);
    if (searchParams.get("term") || searchParams.get("newSynonym")) {
      searchParams.delete("term");
      searchParams.delete("newSynonym");
      setSearchParams(searchParams, { replace: true });
    }
  }

  // The save-blocking flow: build the proposed row set in memory, run the
  // regression suite against it, then ALWAYS rebuild the live dict again
  // afterward (buildLookup mutates module-level engine state — see the note
  // at the top of normalizerEngine.js). Only commit to Supabase if every
  // golden case still passes.
  async function checkAndCommit(proposedRows, commitFn) {
    setChecking(true);
    setBlockedResults(null);
    setSaveError(null);
    try {
      const { data: goldenCases } = await supabase.from("golden_dataset").select("*");
      if (!goldenCases || goldenCases.length === 0) {
        // Nothing to check against — allow the save but say so.
        await commitFn();
        await reload();
        closeForm();
        return;
      }

      const proposedDict = buildLookup(proposedRows);
      const results = await runRegressionSuite(goldenCases, proposedDict);
      const failures = results.filter((r) => !r.passed);

      // Restore live state before doing anything else, pass or fail.
      buildLookup(rows);

      if (failures.length > 0) {
        setBlockedResults(failures);
        return;
      }

      await commitFn();
      await reload(); // re-fetches from Supabase and rebuilds the live dict
      closeForm();
    } catch (err) {
      setSaveError(err.message || String(err));
      buildLookup(rows); // make sure live state is restored even on error
    } finally {
      setChecking(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!rows) return;
    const payload = {
      synonyms: form.synonyms.trim(),
      canonical_term: form.canonical_term.trim() || null,
      category: form.category,
      action: form.action,
      priority: Number(form.priority) || 100,
      output_bucket: OUTPUT_BUCKET_CATEGORIES.has(form.category) && form.output_bucket ? form.output_bucket : null,
      trigger_bucket: form.category === "CONDITIONAL" && form.trigger_bucket ? form.trigger_bucket : null,
    };
    const isNew = form.id === null;
    const proposedRows = isNew
      ? [...rows, { id: -1, ...payload }]
      : rows.map((r) => (r.id === form.id ? { ...r, ...payload } : r));

    await checkAndCommit(proposedRows, async () => {
      if (isNew) {
        const { error: dbError } = await supabase.from("dictionary_terms").insert(payload);
        if (dbError) throw dbError;
      } else {
        const { error: dbError } = await supabase.from("dictionary_terms").update(payload).eq("id", form.id);
        if (dbError) throw dbError;
      }
    });
  }

  async function handleDelete(row) {
    if (!rows) return;
    const proposedRows = rows.filter((r) => r.id !== row.id);
    await checkAndCommit(proposedRows, async () => {
      const { error: dbError } = await supabase.from("dictionary_terms").delete().eq("id", row.id);
      if (dbError) throw dbError;
    });
    setPendingDelete(null);
  }

  return (
    <div className="space-y-5">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-lg font-semibold">Dictionary Manager</h1>
          <p className="text-base-400 text-sm mt-1">
            Every save is checked against the golden regression suite first
            {goldenCount !== null && ` (${goldenCount} case${goldenCount === 1 ? "" : "s"})`}
            . A save that breaks an existing case is blocked, not applied.
          </p>
        </div>
        <button onClick={openNew} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-md text-sm font-semibold whitespace-nowrap">
          + New term
        </button>
      </div>

      {goldenCount === 0 && (
        <div className="text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded-md px-3 py-2">
          No golden cases yet — saves will go through unchecked. Record some in the Playground first so this page
          can actually protect you.
        </div>
      )}

      {error && <div className="text-red-400 text-sm">Failed to load dictionary: {error}</div>}

      <div className="flex gap-3 items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search synonyms, canonical term, or id…"
          className="flex-1 bg-base-900 border border-base-700 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="bg-base-900 border border-base-700 rounded-md px-2 py-1.5 text-sm"
        >
          <option value="ALL">All categories</option>
          {DICTIONARY_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="text-xs text-base-400 whitespace-nowrap">{loading ? "Loading…" : `${filtered.length} of ${rows?.length ?? 0}`}</span>
      </div>

      <div className="border border-base-800 rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-base-900 text-base-400 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Category</th>
              <th className="text-left px-3 py-2 font-medium">Action</th>
              <th className="text-left px-3 py-2 font-medium">Canonical</th>
              <th className="text-left px-3 py-2 font-medium">Synonyms</th>
              <th className="text-left px-3 py-2 font-medium">Prio</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-base-800">
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-base-900/60">
                <td className="px-3 py-1.5 text-xs text-base-400">{r.category}</td>
                <td className="px-3 py-1.5 text-xs">{r.action}</td>
                <td className="px-3 py-1.5 font-medium">{r.canonical_term || <span className="text-base-600">—</span>}</td>
                <td className="px-3 py-1.5 text-base-400 truncate max-w-md" title={r.synonyms}>{r.synonyms}</td>
                <td className="px-3 py-1.5 text-xs text-base-400">{r.priority}</td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  <button onClick={() => openEdit(r)} className="text-xs text-sky-400 hover:text-sky-300 mr-3">Edit</button>
                  <button onClick={() => setPendingDelete(r)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-16 z-50" onClick={closeForm}>
          <form
            onSubmit={handleSubmit}
            onClick={(e) => e.stopPropagation()}
            className="bg-base-900 border border-base-700 rounded-md p-5 w-full max-w-lg space-y-3"
          >
            <div className="flex justify-between items-center">
              <h2 className="font-semibold">{form.id === null ? "New term" : `Edit term #${form.id}`}</h2>
              <button type="button" onClick={closeForm} className="text-base-400 hover:text-base-50">✕</button>
            </div>

            <label className="block text-xs text-base-400">
              Synonyms (comma-separated)
              <textarea
                required
                value={form.synonyms}
                onChange={(e) => setForm({ ...form, synonyms: e.target.value })}
                className="mt-1 w-full bg-base-950 border border-base-700 rounded-md px-2 py-1.5 text-sm text-base-50 min-h-[60px]"
              />
            </label>

            <label className="block text-xs text-base-400">
              Canonical term (leave empty for DELETE-action noise rows)
              <input
                value={form.canonical_term}
                onChange={(e) => setForm({ ...form, canonical_term: e.target.value })}
                className="mt-1 w-full bg-base-950 border border-base-700 rounded-md px-2 py-1.5 text-sm text-base-50"
              />
            </label>

            <div className="flex gap-3">
              <label className="flex-1 text-xs text-base-400">
                Category
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="mt-1 w-full bg-base-950 border border-base-700 rounded-md px-2 py-1.5 text-sm text-base-50"
                >
                  {DICTIONARY_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="flex-1 text-xs text-base-400">
                Action
                <select
                  value={form.action}
                  onChange={(e) => setForm({ ...form, action: e.target.value })}
                  className="mt-1 w-full bg-base-950 border border-base-700 rounded-md px-2 py-1.5 text-sm text-base-50"
                >
                  {DICTIONARY_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <label className="w-24 text-xs text-base-400">
                Priority
                <input
                  type="number"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  className="mt-1 w-full bg-base-950 border border-base-700 rounded-md px-2 py-1.5 text-sm text-base-50"
                />
              </label>
            </div>

            {OUTPUT_BUCKET_CATEGORIES.has(form.category) && (
              <div className="flex gap-3 border border-amber-900 bg-amber-950/20 rounded-md p-2.5">
                <label className="flex-1 text-xs text-base-400">
                  Output bucket <span className="text-base-500">(where this shows up in the final name)</span>
                  <select
                    value={form.output_bucket}
                    onChange={(e) => setForm({ ...form, output_bucket: e.target.value, trigger_bucket: e.target.value ? "" : form.trigger_bucket })}
                    className="mt-1 w-full bg-base-950 border border-base-700 rounded-md px-2 py-1.5 text-sm text-base-50"
                  >
                    <option value="">— not set —</option>
                    {OUTPUT_BUCKETS.filter((b) => b !== "ROOM" && b !== "BEDROOM" && b !== "BEDDING" && b !== "VIEW" && b !== "BUILDING").map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </label>
                {form.category === "CONDITIONAL" && (
                  <label className="flex-1 text-xs text-base-400">
                    Trigger bucket <span className="text-base-500">(blanks that bucket to a placeholder instead)</span>
                    <select
                      value={form.trigger_bucket}
                      onChange={(e) => setForm({ ...form, trigger_bucket: e.target.value, output_bucket: e.target.value ? "" : form.output_bucket })}
                      className="mt-1 w-full bg-base-950 border border-base-700 rounded-md px-2 py-1.5 text-sm text-base-50"
                    >
                      <option value="">— not a trigger —</option>
                      {TRIGGER_BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}

            {saveError && <div className="text-red-400 text-xs">{saveError}</div>}

            {blockedResults && (
              <div className="border border-red-800 bg-red-950/40 rounded-md p-3 space-y-2">
                <div className="text-red-300 text-sm font-semibold">
                  Save blocked — {blockedResults.length} golden case{blockedResults.length === 1 ? "" : "s"} would break:
                </div>
                <div className="space-y-2 max-h-48 overflow-auto">
                  {blockedResults.map((r) => (
                    <div key={r.id} className="text-xs">
                      <div className="font-mono text-base-200">{r.raw_name}</div>
                      {r.error ? (
                        <div className="text-red-400">Engine error: {r.error}</div>
                      ) : (
                        r.diff.filter((d) => !d.match).map((d) => (
                          <div key={d.field} className="text-red-300 pl-2">
                            {d.field}: expected "{Array.isArray(d.expected) ? d.expected.join(", ") : d.expected ?? "—"}"
                            {" "}→ got "{Array.isArray(d.actual) ? d.actual.join(", ") : d.actual ?? "—"}"
                          </div>
                        ))
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={closeForm} className="px-3 py-1.5 text-sm text-base-400 hover:text-base-50">
                Cancel
              </button>
              <button
                type="submit"
                disabled={checking}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-base-700 rounded-md text-sm font-semibold"
              >
                {checking ? "Checking against golden cases…" : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-16 z-50" onClick={() => setPendingDelete(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-base-900 border border-base-700 rounded-md p-5 w-full max-w-md space-y-3">
            <div className="font-semibold">Delete term #{pendingDelete.id}?</div>
            <div className="text-sm text-base-400">
              "{pendingDelete.canonical_term || pendingDelete.synonyms}" — this will be checked against the golden suite first.
            </div>
            {blockedResults && (
              <div className="border border-red-800 bg-red-950/40 rounded-md p-3 text-xs text-red-300 space-y-1 max-h-48 overflow-auto">
                {blockedResults.map((r) => <div key={r.id} className="font-mono">{r.raw_name}</div>)}
              </div>
            )}
            {saveError && <div className="text-red-400 text-xs">{saveError}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setPendingDelete(null); setBlockedResults(null); }} className="px-3 py-1.5 text-sm text-base-400 hover:text-base-50">
                Cancel
              </button>
              <button
                onClick={() => handleDelete(pendingDelete)}
                disabled={checking}
                className="px-4 py-1.5 bg-red-700 hover:bg-red-600 disabled:bg-base-700 rounded-md text-sm font-semibold"
              >
                {checking ? "Checking…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
