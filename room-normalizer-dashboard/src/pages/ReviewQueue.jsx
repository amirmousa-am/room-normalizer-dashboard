export default function ReviewQueue() {
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Review Queue</h1>
      <p className="text-base-400 text-sm max-w-2xl">Pending review_queue items sorted by occurrence, with Attach/Ignore actions via resolve_review_queue_item.</p>
      <div className="border border-dashed border-base-700 rounded-md p-8 text-center text-base-400 text-sm">
        Not built yet — next up per the build order in the dashboard spec.
        <br />
        The Engine Playground is fully wired; this page is scaffolded and ready to build against it.
      </div>
    </div>
  );
}
