const STYLES: Record<string, string> = {
  queued: "bg-signal-queued/15 text-signal-queued border-signal-queued/30",
  scheduled: "bg-signal-queued/15 text-signal-queued border-signal-queued/30",
  claimed: "bg-signal-running/15 text-signal-running border-signal-running/30",
  running: "bg-signal-running/15 text-signal-running border-signal-running/30",
  retrying: "bg-signal-running/15 text-signal-running border-signal-running/30",
  completed: "bg-signal-completed/15 text-signal-completed border-signal-completed/30",
  failed: "bg-signal-failed/15 text-signal-failed border-signal-failed/30",
  dead_letter: "bg-signal-dead/20 text-red-300 border-signal-dead/40",
  cancelled: "bg-signal-cancelled/15 text-signal-cancelled border-signal-cancelled/30",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium mono ${
        STYLES[status] ?? "bg-white/10 text-text-mid border-white/10"
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status.replace("_", " ")}
    </span>
  );
}
