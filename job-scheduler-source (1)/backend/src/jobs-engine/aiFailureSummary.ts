import { pool } from "../db/pool.js";
import { config } from "../config/env.js";

/**
 * Bonus feature: when a job is moved to the Dead Letter Queue, generate
 * a short human-readable summary of *why* it likely failed, to save an
 * on-call engineer from reading raw stack traces at 3am.
 *
 * If ANTHROPIC_API_KEY is configured, this calls the real Claude API.
 * Otherwise it falls back to a deterministic local heuristic so the
 * feature still works end-to-end in an offline/evaluation environment
 * without requiring a paid key.
 */
export async function maybeGenerateFailureSummary(jobId: string, handler: string, errorMessage: string) {
  const summary = config.aiSummaryEnabled && config.anthropicApiKey
    ? await callClaude(handler, errorMessage)
    : heuristicSummary(handler, errorMessage);

  await pool.query(`UPDATE dead_letter_queue SET ai_failure_summary = $1 WHERE job_id = $2`, [summary, jobId]);
}

async function callClaude(handler: string, errorMessage: string): Promise<string> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 150,
        messages: [
          {
            role: "user",
            content: `A background job handler "${handler}" permanently failed after exhausting retries with this error:\n\n${errorMessage}\n\nIn 2-3 sentences, summarize the likely root cause and suggest one concrete next step for an on-call engineer.`,
          },
        ],
      }),
    });
    const data = await res.json();
    const text = data?.content?.find((c: any) => c.type === "text")?.text;
    return text ?? heuristicSummary(handler, errorMessage);
  } catch {
    return heuristicSummary(handler, errorMessage);
  }
}

/** Lightweight rule-based fallback — categorizes common error patterns. */
function heuristicSummary(handler: string, errorMessage: string): string {
  const msg = errorMessage.toLowerCase();
  let category = "an unclassified error";
  if (msg.includes("timeout")) category = "a timeout, likely a slow or unresponsive downstream dependency";
  else if (msg.includes("econnrefused") || msg.includes("network")) category = "a network/connectivity failure";
  else if (msg.includes("permission") || msg.includes("unauthorized") || msg.includes("403"))
    category = "a permissions/authentication issue";
  else if (msg.includes("validation") || msg.includes("invalid")) category = "invalid input payload";
  else if (msg.includes("out of memory") || msg.includes("heap")) category = "a resource exhaustion issue";

  return `Handler "${handler}" exhausted all retries. Root cause appears to be ${category}. Original error: "${errorMessage}". Suggested next step: inspect the last execution's logs and, if this is systemic, pause the queue before replaying from the DLQ.`;
}
