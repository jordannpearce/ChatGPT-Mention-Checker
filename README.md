# ChatGPT Mention Checker (PUBLIC version)

A public, bring-your-own-key tool: visitors test **their own** brands.
Nelson directed on 2026-11-02 that this app is an exception to his
no-public-tools direction — it is meant to be offered for people to use.

## How visitors use it
1. Enter name + email (+ optional business) — email is required for live runs (lead capture).
2. Paste their own DataForSEO API login/password (from app.dataforseo.com → API Access) and test it.
3. Run either mode. Without a key, the tool runs in clearly-flagged DEMO mode with sample data.

## Privacy / credential handling (important)
- Visitor credentials are sent **per request** through the server proxy to
  api.dataforseo.com and are **never stored** on the server — no file, no DB, no logs.
- Optional "remember" keeps them only in the visitor's own browser (localStorage).
- Check history is kept only in the visitor's browser.
- Live runs append a lead to `data/leads.json` (name, email, business, brand/domain/target,
  hit-rate or prompt count, timestamp — never credentials, never full answers).
- Rate limit: 30 runs per IP per hour (in-memory).
- Owner-managed mode: if `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` env vars are set,
  visitors' runs use the owner's account (owner pays) and no lead email is required.
  Leave them unset for the public BYO-key mode.

## Run / deploy
```
node server.js          # http://localhost:3456  (PORT env to change)
npm start               # same
```
Zero dependencies, Node 18+. Any Node host works (Railway etc.): set PORT, deploy the folder.
DataForSEO charges go to whoever's key is used: Prompt Checker ≈ a few cents per prompt
(model/tokens dependent; docs example ~$0.0296 for gpt-4.1-mini); Mentions Explorer is
$0.10/request + $0.001/row and requires an eligible account (launched with a reported
$100/mo minimum commitment — visitors without eligibility will see DataForSEO's error).

## Modes
1. **Prompt Checker** — `POST /v3/ai_optimization/chat_gpt/llm_responses/live`.
   Up to 10 visitor prompts per run, sequential. Model list pulled live from
   `GET /v3/ai_optimization/chat_gpt/llm_responses/models` using the visitor's key.
   Per prompt: brand mentioned? (count/position), domain cited? (annotations + search_results),
   competitor counts, fan-out queries, tokens, money_spent.
2. **Mentions Explorer** — `POST /v3/ai_optimization/llm_mentions/search_mentions/live`.
   Domain or keyword target; platform `chat_gpt` (US 2840 / English only) or `google`.
   Returns real user prompts: question, full answer, sources, ai_search_volume, dates.

## Files
- `server.js` — proxy, mention analysis, demo data, leads, rate limit
- `public/index.html` — public landing + tool UI
- `data/leads.json` — created at runtime (gitignored)
