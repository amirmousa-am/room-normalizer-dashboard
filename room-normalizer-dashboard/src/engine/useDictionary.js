import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { buildLookup } from "./normalizerEngine";

// Loads dictionary_terms (same query shape the userscript uses) and builds
// the lookup dict. Exposes a manual reload() for "refresh from Supabase".
//
// NOTE: because buildLookup() mutates module-level engine state (see the
// architectural-quirk note in normalizerEngine.js), only one place in the
// app should treat its dict as "live" at a time. Pages that need to test a
// *proposed* dictionary (Dictionary Manager's save-blocking check) must
// call buildLookup() again with the live rows afterward to restore state —
// see dictionaryManager helpers.
export function useDictionary() {
  const [rows, setRows] = useState(null);
  const [dict, setDict] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: dbError } = await supabase
        .from("dictionary_terms")
        .select("id,synonyms,canonical_term,category,action,priority")
        .order("priority", { ascending: true })
        .order("id", { ascending: true });
      if (dbError) throw dbError;
      setRows(data);
      setDict(buildLookup(data));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { rows, dict, loading, error, reload };
}
