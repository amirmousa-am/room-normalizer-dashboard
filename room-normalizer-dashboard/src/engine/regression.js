import { normalizeCore } from "./normalizerEngine";

// The 9 fields normalizeCore always emits on parsed_components. Golden case
// `expected` blobs should have this same shape (that's what Playground's
// "Save as golden case" writes).
const FIELDS = ["class", "occupancy", "type", "bedroom", "bedding", "view", "building", "amenity", "custom"];

function normalizeForCompare(v) {
  // Arrays compare order-sensitively (engine output order is deterministic),
  // but treat [] and null as equivalent so an empty array in `expected`
  // matches a null/omitted value in `actual` or vice versa.
  if (Array.isArray(v) && v.length === 0) return null;
  return v ?? null;
}

export function diffComponents(expected, actual) {
  return FIELDS.map((field) => {
    const e = normalizeForCompare(expected?.[field]);
    const a = normalizeForCompare(actual?.[field]);
    return { field, expected: e, actual: a, match: JSON.stringify(e) === JSON.stringify(a) };
  });
}

// Runs every golden case against the given dict (live or proposed) and
// returns per-case pass/fail + field diff. Does not touch the database.
export async function runRegressionSuite(goldenCases, dict) {
  const results = [];
  for (const g of goldenCases) {
    let actual = null;
    let error = null;
    try {
      const r = await normalizeCore(g.raw_name, dict, { trace: false, diagnostics: false });
      actual = r.parsed_components;
    } catch (err) {
      error = err.message || String(err);
    }
    const diff = actual ? diffComponents(g.expected, actual) : [];
    const passed = !error && diff.every((d) => d.match);
    results.push({ id: g.id, raw_name: g.raw_name, expected: g.expected, actual, diff, passed, error });
  }
  return results;
}
