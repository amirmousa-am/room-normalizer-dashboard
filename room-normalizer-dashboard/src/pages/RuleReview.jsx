export default function RuleReview() {
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Rule Review</h1>
      <p className="text-base-400 text-sm max-w-2xl">Dead dictionary rows, AMBIGUOUS_DROP clusters, and UNPAIRED_SEMANTIC patterns surfaced from rule_hits + review_queue.</p>
      <div className="border border-dashed border-base-700 rounded-md p-8 text-center text-base-400 text-sm">
        Not built yet — next up per the build order in the dashboard spec.
        <br />
        The Engine Playground is fully wired; this page is scaffolded and ready to build against it.
      </div>
    </div>
  );
}
