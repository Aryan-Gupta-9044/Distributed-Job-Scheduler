interface Worker {
  id: string;
  hostname: string;
  status: string;
  is_healthy: boolean;
  max_concurrency: number;
}

export function WorkerPulseStrip({ workers }: { workers: Worker[] }) {
  if (!workers.length) {
    return <div className="text-sm text-text-low mono">No workers registered yet.</div>;
  }
  return (
    <div className="flex flex-wrap gap-3">
      {workers.map((w) => (
        <div
          key={w.id}
          className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2"
          title={`${w.hostname} · capacity ${w.max_concurrency}`}
        >
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              w.is_healthy ? "bg-signal-completed pulse-live" : "bg-signal-dead pulse-dead"
            }`}
          />
          <span className="mono text-xs text-text-mid">{w.hostname}</span>
          <span className="mono text-[10px] text-text-low">·{w.max_concurrency}</span>
        </div>
      ))}
    </div>
  );
}
