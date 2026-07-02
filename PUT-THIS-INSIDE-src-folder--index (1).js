/**
 * SupplyMate AI Platform — AI Router
 * Doc 03 §5, Doc 05: applications never call an AI provider directly.
 * They call THIS worker. Adding a new provider later means adding one
 * branch in callProvider() — no application is ever touched.
 *
 * Routes:
 *   GET  /health
 *   POST /route   -> { task, department, prompt, preferredProvider? }
 *   GET  /usage   -> aggregate stats powering AI Benchmarking + Cost Dashboard
 */

// Rough public pricing per 1M tokens, used only to estimate cost for the
// Cost Dashboard — not billing-accurate, good enough to compare providers.
const PRICING = {
  Claude: { input: 3.0, output: 15.0 },
  ChatGPT: { input: 2.5, output: 10.0 },
  Grok: { input: 2.0, output: 10.0 },
  Gemini: { input: 1.25, output: 5.0 },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function estimateCost(provider, inputTokens, outputTokens) {
  const rate = PRICING[provider] || PRICING.Claude;
  return (inputTokens / 1e6) * rate.input + (outputTokens / 1e6) * rate.output;
}

// Only Claude is wired to a real provider today. Preferred provider is
// accepted but currently always routes to Claude — this is the seam where
// GPT/Gemini/Grok adapters get added later, per Doc 05 §2 Provider Adapter.
async function callProvider(provider, prompt, env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY secret is not set on this Worker.");
  }
  const started = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return {
    text: data.content?.[0]?.text || "",
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
    latencyMs,
    model: data.model,
  };
}

async function handleRoute(request, env) {
  const body = await request.json();
  const { task, department, prompt, preferredProvider } = body;
  if (!task || !prompt) {
    return jsonResponse({ error: "Both 'task' and 'prompt' are required." }, 400);
  }

  const provider = "Claude"; // preferredProvider is accepted, but only Claude is live today
  let result;
  try {
    result = await callProvider(provider, prompt, env);
  } catch (err) {
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (task, department, provider, model, prompt_preview, status)
       VALUES (?, ?, ?, ?, ?, 'error')`
    )
      .bind(task, department || null, provider, "claude-sonnet-4-6", prompt.slice(0, 200))
      .run();
    return jsonResponse({ error: err.message }, 502);
  }

  const cost = estimateCost(provider, result.inputTokens, result.outputTokens);

  await env.DB.prepare(
    `INSERT INTO ai_usage_log
       (task, department, provider, model, prompt_preview, response_preview,
        input_tokens, output_tokens, estimated_cost_usd, latency_ms, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success')`
  )
    .bind(
      task,
      department || null,
      provider,
      result.model,
      prompt.slice(0, 200),
      result.text.slice(0, 200),
      result.inputTokens,
      result.outputTokens,
      cost,
      result.latencyMs
    )
    .run();

  return jsonResponse({
    output: result.text,
    provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: +cost.toFixed(6),
    latencyMs: result.latencyMs,
  });
}

async function handleUsage(env) {
  const byProvider = await env.DB.prepare(
    `SELECT provider,
            COUNT(*) as calls,
            ROUND(SUM(estimated_cost_usd), 4) as totalCostUsd,
            ROUND(AVG(latency_ms), 0) as avgLatencyMs,
            ROUND(AVG(user_rating), 2) as avgRating
     FROM ai_usage_log WHERE status = 'success' GROUP BY provider`
  ).all();

  const byDepartment = await env.DB.prepare(
    `SELECT department,
            COUNT(*) as calls,
            ROUND(SUM(estimated_cost_usd), 4) as totalCostUsd
     FROM ai_usage_log WHERE status = 'success' AND department IS NOT NULL
     GROUP BY department ORDER BY totalCostUsd DESC`
  ).all();

  const recent = await env.DB.prepare(
    `SELECT created_at, task, department, provider, model,
            estimated_cost_usd as costUsd, latency_ms as latencyMs, status
     FROM ai_usage_log ORDER BY created_at DESC LIMIT 20`
  ).all();

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) as totalCalls,
            ROUND(SUM(estimated_cost_usd), 4) as totalCostUsd
     FROM ai_usage_log WHERE status = 'success'`
  ).first();

  return jsonResponse({
    totals,
    byProvider: byProvider.results,
    byDepartment: byDepartment.results,
    recent: recent.results,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "ai-router" });
    }
    if (url.pathname === "/route" && request.method === "POST") {
      return handleRoute(request, env);
    }
    if (url.pathname === "/usage" && request.method === "GET") {
      return handleUsage(env);
    }
    return jsonResponse({ error: "Use POST /route or GET /usage" }, 400);
  },
};
