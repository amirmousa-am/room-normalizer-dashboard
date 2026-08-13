export default function RegressionTests() {
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Regression Tests</h1>
      <p className="text-base-400 text-sm max-w-2xl">Loads golden_dataset, runs normalizeCore against the live dictionary, and diffs parsed_components field-by-field.</p>
      <div className="border border-dashed border-base-700 rounded-md p-8 text-center text-base-400 text-sm">
        Not built yet — next up per the build order in the dashboard spec.
        <br />
        The Engine Playground is fully wired; this page is scaffolded and ready to build against it.
      </div>
    </div>
  );
}
