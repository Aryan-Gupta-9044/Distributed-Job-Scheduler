/**
 * Handlers are pure functions keyed by name. `jobs.handler` in the DB
 * stores this key; the worker looks it up at execution time. In a real
 * deployment these would call out to email providers, webhooks, data
 * pipelines, etc. — swappable without touching the scheduling engine.
 */
export const handlers: Record<string, (payload: any) => Promise<void>> = {
  "send-email": async (payload) => {
    if (!payload?.to) throw new Error("Validation error: payload.to is required");
    await sleep(200);
  },
  "webhook-call": async (payload) => {
    if (!payload?.url) throw new Error("Validation error: payload.url is required");
    const res = await fetch(payload.url, { method: "POST", body: JSON.stringify(payload.body ?? {}) }).catch((e) => {
      throw new Error(`Network error calling webhook: ${e.message}`);
    });
    if (res && !res.ok) throw new Error(`Webhook returned ${res.status}`);
  },
  "generate-report": async (payload) => {
    await sleep(500);
    if (Math.random() < (payload?.failureRate ?? 0)) throw new Error("Report generation timeout");
  },
  "noop": async () => {
    await sleep(50);
  },
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
