import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setSession } from "../api/client.js";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const path = mode === "login" ? "/auth/login" : "/auth/register";
      const body = mode === "login" ? { email, password } : { email, password, name, orgName };
      const { data } = await api.post(path, body);
      setSession(data.token);
      nav("/");
    } catch (err: any) {
      setError(err?.response?.data?.error?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2">
          <div className="h-8 w-8 rounded-md bg-signal-completed/20 border border-signal-completed/40 flex items-center justify-center pulse-live">
            <span className="h-2.5 w-2.5 rounded-full bg-signal-completed" />
          </div>
          <span className="font-display text-xl font-semibold tracking-tight">Pulse</span>
        </div>

        <div className="rounded-xl border border-line bg-panel p-6">
          <h1 className="font-display text-lg font-semibold mb-1">
            {mode === "login" ? "Sign in" : "Create your workspace"}
          </h1>
          <p className="text-sm text-text-mid mb-5">
            {mode === "login" ? "Access your scheduler dashboard." : "Sets up your org and first admin account."}
          </p>

          <form onSubmit={submit} className="space-y-3">
            {mode === "register" && (
              <>
                <Field label="Your name" value={name} onChange={setName} />
                <Field label="Organization name" value={orgName} onChange={setOrgName} />
              </>
            )}
            <Field label="Email" type="email" value={email} onChange={setEmail} />
            <Field label="Password" type="password" value={password} onChange={setPassword} />

            {error && <p className="text-sm text-signal-failed mono">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-signal-queued/90 hover:bg-signal-queued text-ink font-semibold py-2.5 text-sm transition disabled:opacity-50"
            >
              {loading ? "Working…" : mode === "login" ? "Sign in" : "Create workspace"}
            </button>
          </form>

          <button
            className="mt-4 text-xs text-text-mid hover:text-text-hi underline underline-offset-2"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "Need a workspace? Create one" : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-text-mid mb-1">{label}</span>
      <input
        required
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-sm outline-none focus:border-signal-queued transition"
      />
    </label>
  );
}
