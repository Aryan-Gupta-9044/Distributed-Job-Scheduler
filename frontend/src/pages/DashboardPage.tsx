import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, clearSession } from "../api/client.js";
import { useSocket } from "../hooks/useSocket.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { WorkerPulseStrip } from "../components/WorkerPulseStrip.js";

type Tab = "queues" | "jobs" | "workers" | "dlq";

export default function DashboardPage() {
  const nav = useNavigate();
  const socket = useSocket();

  const [orgs, setOrgs] = useState<any[]>([]);
  const [orgId, setOrgId] = useState<string>("");
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [queues, setQueues] = useState<any[]>([]);
  const [queueId, setQueueId] = useState<string>("");
  const [tab, setTab] = useState<Tab>("queues");
  const [jobs, setJobs] = useState<any[]>([]);
  const [dlq, setDlq] = useState<any[]>([]);
  const [workers, setWorkers] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");

  useEffect(() => {
    api.get("/orgs").then((r) => {
      setOrgs(r.data.data);
      if (r.data.data[0]) setOrgId(r.data.data[0].id);
    });
    api.get("/workers").then((r) => setWorkers(r.data.data));
  }, []);

  useEffect(() => {
    if (!orgId) return;
    api.get(`/orgs/${orgId}/projects`).then((r) => {
      setProjects(r.data.data);
      if (r.data.data[0]) setProjectId(r.data.data[0].id);
      else setProjectId("");
    });
  }, [orgId]);

  useEffect(() => {
    if (!projectId) return setQueues([]);
    api.get(`/projects/${projectId}/queues`).then((r) => {
      setQueues(r.data.data);
      if (r.data.data[0]) setQueueId(r.data.data[0].id);
      else setQueueId("");
    });
  }, [projectId]);

  async function refreshJobs() {
    if (!queueId) return;
    const { data } = await api.get(`/queues/${queueId}/jobs`, { params: { status: statusFilter || undefined } });
    setJobs(data.data);
  }

  async function refreshDlq() {
    if (!queueId) return;
    const { data } = await api.get(`/queues/${queueId}/dlq`);
    setDlq(data.data);
  }

  useEffect(() => {
    if (tab === "jobs") refreshJobs();
    if (tab === "dlq") refreshDlq();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, queueId, statusFilter]);

  useEffect(() => {
    if (!queueId || !socket.current) return;
    socket.current.emit("subscribe:queue", queueId);
    const onUpdate = () => {
      if (tab === "jobs") refreshJobs();
    };
    socket.current.on("job:update", onUpdate);
    return () => {
      socket.current?.off("job:update", onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueId, tab]);

  function logout() {
    clearSession();
    nav("/login");
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-signal-completed/20 border border-signal-completed/40 flex items-center justify-center pulse-live">
            <span className="h-2 w-2 rounded-full bg-signal-completed" />
          </div>
          <span className="font-display font-semibold">Pulse</span>
        </div>
        <div className="flex items-center gap-3">
          <Select value={orgId} onChange={setOrgId} options={orgs.map((o) => ({ value: o.id, label: o.name }))} />
          <Select
            value={projectId}
            onChange={setProjectId}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
            placeholder="No projects"
          />
          <button onClick={logout} className="text-xs text-text-mid hover:text-text-hi">
            Sign out
          </button>
        </div>
      </header>

      <div className="px-6 py-4 border-b border-line">
        <div className="text-xs text-text-low mb-2 mono">WORKERS</div>
        <WorkerPulseStrip workers={workers} />
      </div>

      <div className="px-6 py-4 flex items-center gap-4 border-b border-line">
        <Select
          value={queueId}
          onChange={setQueueId}
          options={queues.map((q) => ({ value: q.id, label: `${q.name} (p${q.priority})` }))}
          placeholder="No queues"
        />
        <nav className="flex gap-1">
          {(["queues", "jobs", "workers", "dlq"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-md text-sm capitalize transition ${
                tab === t ? "bg-panel2 text-text-hi border border-line" : "text-text-mid hover:text-text-hi"
              }`}
            >
              {t === "dlq" ? "Dead letters" : t}
            </button>
          ))}
        </nav>
      </div>

      <main className="p-6">
        {tab === "queues" && (
          <QueuesPanel projectId={projectId} queues={queues} onCreated={() => projectId && api.get(`/projects/${projectId}/queues`).then((r) => setQueues(r.data.data))} />
        )}
        {tab === "jobs" && (
          <JobsPanel
            queueId={queueId}
            jobs={jobs}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            onRefresh={refreshJobs}
          />
        )}
        {tab === "workers" && <WorkersPanel workers={workers} />}
        {tab === "dlq" && <DlqPanel entries={dlq} onReplay={refreshDlq} />}
      </main>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-sm outline-none focus:border-signal-queued"
    >
      {options.length === 0 && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function QueuesPanel({ projectId, queues, onCreated }: { projectId: string; queues: any[]; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [concurrency, setConcurrency] = useState(5);
  const [stats, setStats] = useState<Record<string, any>>({});

  useEffect(() => {
    queues.forEach((q) => {
      api.get(`/queues/${q.id}/stats`).then((r) => setStats((s) => ({ ...s, [q.id]: r.data.data })));
    });
  }, [queues]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    await api.post(`/projects/${projectId}/queues`, { name, concurrencyLimit: concurrency });
    setName("");
    onCreated();
  }

  async function toggle(q: any) {
    await api.post(`/queues/${q.id}/${q.is_paused ? "resume" : "pause"}`);
    onCreated();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="flex items-end gap-3 rounded-xl border border-line bg-panel p-4">
        <label className="text-sm">
          <span className="block text-xs text-text-mid mb-1">Queue name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-sm outline-none focus:border-signal-queued"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-text-mid mb-1">Concurrency</span>
          <input
            type="number"
            min={1}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            className="w-24 rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-sm outline-none focus:border-signal-queued"
          />
        </label>
        <button className="rounded-md bg-signal-queued/90 hover:bg-signal-queued text-ink text-sm font-semibold px-3 py-1.5">
          Create queue
        </button>
      </form>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {queues.map((q) => {
          const s = stats[q.id];
          const counts: Record<string, number> = {};
          s?.statusCounts?.forEach((c: any) => (counts[c.status] = c.count));
          return (
            <div key={q.id} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium">{q.name}</span>
                <button
                  onClick={() => toggle(q)}
                  className={`text-xs rounded-full px-2 py-0.5 border ${
                    q.is_paused
                      ? "border-signal-failed/40 text-signal-failed"
                      : "border-signal-completed/40 text-signal-completed"
                  }`}
                >
                  {q.is_paused ? "Paused" : "Active"}
                </button>
              </div>
              <div className="text-xs text-text-mid mono mb-3">
                priority {q.priority} · concurrency {q.concurrency_limit}
                {q.rate_limit_per_sec ? ` · ${q.rate_limit_per_sec}/s` : ""}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(counts).map(([status, count]) => (
                  <span key={status} className="text-[11px] mono text-text-mid">
                    <StatusBadge status={status} /> <span className="ml-1">{count}</span>
                  </span>
                ))}
                {!Object.keys(counts).length && <span className="text-xs text-text-low">No jobs yet</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function JobsPanel({
  queueId,
  jobs,
  statusFilter,
  setStatusFilter,
  onRefresh,
}: {
  queueId: string;
  jobs: any[];
  statusFilter: string;
  setStatusFilter: (s: string) => void;
  onRefresh: () => void;
}) {
  const [handler, setHandler] = useState("noop");
  const [payload, setPayload] = useState("{}");
  const [type, setType] = useState("immediate");
  const [delaySeconds, setDelaySeconds] = useState(30);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    let parsed = {};
    try {
      parsed = JSON.parse(payload || "{}");
    } catch {
      alert("Payload must be valid JSON");
      return;
    }
    const body: any = { type, handler, payload: parsed };
    if (type === "delayed") body.delaySeconds = delaySeconds;
    await api.post(`/queues/${queueId}/jobs`, body);
    onRefresh();
  }

  async function cancel(id: string) {
    await api.post(`/jobs/${id}/cancel`);
    onRefresh();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-panel p-4">
        <label className="text-sm">
          <span className="block text-xs text-text-mid mb-1">Type</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-sm"
          >
            <option value="immediate">immediate</option>
            <option value="delayed">delayed</option>
          </select>
        </label>
        {type === "delayed" && (
          <label className="text-sm">
            <span className="block text-xs text-text-mid mb-1">Delay (s)</span>
            <input
              type="number"
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(Number(e.target.value))}
              className="w-24 rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-sm"
            />
          </label>
        )}
        <label className="text-sm">
          <span className="block text-xs text-text-mid mb-1">Handler</span>
          <input
            value={handler}
            onChange={(e) => setHandler(e.target.value)}
            className="rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm flex-1 min-w-[220px]">
          <span className="block text-xs text-text-mid mb-1">Payload (JSON)</span>
          <input
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            className="w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-sm mono"
          />
        </label>
        <button className="rounded-md bg-signal-queued/90 hover:bg-signal-queued text-ink text-sm font-semibold px-3 py-1.5">
          Enqueue job
        </button>
      </form>

      <div className="flex gap-2">
        {["", "queued", "running", "completed", "failed", "dead_letter", "cancelled"].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-xs rounded-full px-2.5 py-1 border ${
              statusFilter === s ? "border-text-hi text-text-hi" : "border-line text-text-mid"
            }`}
          >
            {s || "all"}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-line overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-panel2 text-text-mid text-xs">
            <tr>
              <th className="text-left px-4 py-2 font-medium">ID</th>
              <th className="text-left px-4 py-2 font-medium">Handler</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-left px-4 py-2 font-medium">Attempt</th>
              <th className="text-left px-4 py-2 font-medium">Created</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-t border-line hover:bg-panel/60">
                <td className="px-4 py-2 mono text-xs text-text-mid">{j.id.slice(0, 8)}</td>
                <td className="px-4 py-2">{j.handler}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={j.status} />
                </td>
                <td className="px-4 py-2 mono text-xs">{j.attempt}</td>
                <td className="px-4 py-2 mono text-xs text-text-mid">{new Date(j.created_at).toLocaleTimeString()}</td>
                <td className="px-4 py-2 text-right">
                  {["queued", "scheduled", "retrying"].includes(j.status) && (
                    <button onClick={() => cancel(j.id)} className="text-xs text-signal-failed hover:underline">
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!jobs.length && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-text-low text-sm">
                  No jobs match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkersPanel({ workers }: { workers: any[] }) {
  return (
    <div className="rounded-xl border border-line overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-panel2 text-text-mid text-xs">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Hostname</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="text-left px-4 py-2 font-medium">Max concurrency</th>
            <th className="text-left px-4 py-2 font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => (
            <tr key={w.id} className="border-t border-line">
              <td className="px-4 py-2 mono">{w.hostname}</td>
              <td className="px-4 py-2">
                <span className={w.is_healthy ? "text-signal-completed" : "text-signal-dead"}>
                  {w.is_healthy ? "healthy" : "stale"}
                </span>
              </td>
              <td className="px-4 py-2 mono">{w.max_concurrency}</td>
              <td className="px-4 py-2 mono text-xs text-text-mid">{new Date(w.last_seen_at).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DlqPanel({ entries, onReplay }: { entries: any[]; onReplay: () => void }) {
  async function replay(id: string) {
    await api.post(`/dlq/${id}/replay`);
    onReplay();
  }
  return (
    <div className="space-y-3">
      {entries.map((e) => (
        <div key={e.id} className="rounded-xl border border-signal-dead/30 bg-panel p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium">{e.handler}</span>
            <button onClick={() => replay(e.id)} className="text-xs text-signal-queued hover:underline">
              Replay
            </button>
          </div>
          <div className="text-xs text-text-mid mono mb-2">
            {e.total_attempts} attempts · moved {new Date(e.moved_at).toLocaleString()}
          </div>
          {e.ai_failure_summary && (
            <p className="text-xs text-text-mid bg-panel2 rounded-md p-2 border border-line">{e.ai_failure_summary}</p>
          )}
        </div>
      ))}
      {!entries.length && <div className="text-sm text-text-low">Dead letter queue is empty. Good sign.</div>}
    </div>
  );
}
