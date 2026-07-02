# AI Router

The Universal AI Engine for the SupplyMate AI Platform (Doc 03 §5, Doc 05).
Every AI-powered app calls this Worker instead of an AI provider directly.
Adding GPT, Gemini, or Grok later means adding one branch inside
`callProvider()` in `src/index.js` — no application is ever touched.

The database (`platform-ai-usage`, a Cloudflare D1 database) has already
been created and its schema set up — nothing to do there.

## What it does

- `POST /route` — send a task, it calls Claude, logs the result (cost,
  latency, tokens) to D1, and returns the output.
- `GET /usage` — aggregate stats by provider and department, powering the
  AI Benchmarking Center and AI Cost Dashboard.

## One-time setup

1. **Get an Anthropic API key**
   Go to [console.anthropic.com](https://console.anthropic.com) → API Keys
   → Create Key. Copy it.

2. **Deploy the repo**
   Push this to GitHub as `AI-Router` under `websupplymate-ai`, same as your
   other repos. Connect it in Cloudflare (Workers & Pages → Create
   application → Import a repository). The D1 binding in `wrangler.toml`
   is already pointed at the real database — Cloudflare will attach it
   automatically on deploy.

3. **Set the secret**
   In the deployed Worker's Settings → Variables and Secrets:
   - `ANTHROPIC_API_KEY` — the key from step 1

## Test it

```
GET /health
```

```
POST /route
{
  "task": "Draft Email",
  "department": "Sales OS",
  "prompt": "Write a short follow-up email to a lead who went quiet."
}
```

```
GET /usage
```

## Notes

- Only Claude is wired to a real provider today. Six sample historical
  rows (Claude, ChatGPT, Grok) are pre-seeded in the database so the
  Benchmarking and Cost dashboards aren't empty on first load — real calls
  through `/route` add to that same table.
- Cost estimates use rough public per-token pricing, not exact billing —
  good for comparing providers, not for invoicing.
- Every AI-generated recommendation, draft, or analysis anywhere in the
  platform should eventually flow through this Worker, per Doc 05 §2.
