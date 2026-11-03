# DECISIONS

Assumptions and trade-offs, with reasons. Nobody was available to ask, so each ambiguity was resolved and logged here.

## Phase 1 - idea selection
Scored 1-5 on: Judging fit (JF), Solo feasibility (SF), Demo impact (DI), Originality (O).

| # | Idea | JF | SF | DI | O | Total |
|---|---|---|---|---|---|---|
| 1 | **Mandate**: spending rails for AI shopping agents; policy gate + PayPal approval/capture + ledger | 5 | 4 | 5 | 4 | **18** |
| 2 | Freelancer invoice agent: AI turns messy client emails into PayPal invoices and chases payment | 4 | 5 | 3 | 2 | 14 |
| 3 | Group-trip bill splitter: AI reads receipts, creates per-person PayPal requests + payouts | 4 | 3 | 4 | 3 | 14 |
| 4 | Shopping concierge: natural language to cart to PayPal checkout (no guardrails) | 4 | 5 | 3 | 1 | 13 |
| 5 | Creator "pay-per-answer" micropayments for an AI chatbot | 3 | 4 | 3 | 3 | 13 |

**Chosen: Mandate.** It targets two named prizes directly (Best Use of Agentic Commerce, Best Use of PayPal + AI) and scores on all five criteria: PayPal is structural (orders, approval, capture, webhooks, refunds are the trust layer, not a bolt-on button); the demo has a clear story with a visible "blocked" moment; the problem (agents spending money safely) is current and specific; and it is feasible solo because the policy engine is plain code and PayPal does the hard payments work. Not revisited.

## Product decisions
- **Human approval stays in the loop.** Fully autonomous capture would need PayPal Vault / billing agreements, which add setup friction for judges and risk. The product thesis is "agent proposes, policy gates, human consents with one tap", so approval is a feature, not a limitation.
- **Policy is code, not prompt.** The LLM cannot override the cap, budget or category rules because they run server-side after the model has spoken. The system prompt also forbids splitting purchases to dodge a cap, but the guarantee comes from the server (reservations count against the budget, and a duplicate guard blocks repeat proposals).
- **Blocked purchases are recorded** (status `blocked`, audit entry) but never create a PayPal order. This is shown in the ledger on purpose: observability of agent behaviour is part of the value.
- **Budget reservations.** Pending orders count against the budget so an agent cannot over-commit by queueing many orders. Declined/cancelled/expired/refunded purchases release funds.
- **Duplicate check runs before cap/budget** so repeated proposals get the more useful "duplicate" reason.
- **Per-visitor sessions via cookie**, each with its own seeded mandate. Lets multiple judges test concurrently without clobbering each other. No sign-up (friction) and no PII stored.
- **Offline agent.** Judges may not have an Anthropic key, and the free-tier deploy should never show a broken screen. The offline agent shares the exact tools and policy gate; the UI labels which brain is active. If the Claude call fails, the request falls back to the offline agent and says so.
- **Seed catalog** of 13 products stands in for a merchant feed (e.g. Channel3). Prices are authoritative in the DB; the model and the browser never supply amounts.

## Technical decisions
- **Node 22.13+ with built-in `node:sqlite`:** no native build step; works on Render free tier. Trade-off: still labelled "experimental" in some Node versions (prints a warning on 22.x), accepted for zero-install benefit.
- **No PayPal server SDK; plain `fetch` against documented REST endpoints** (`/v1/oauth2/token`, `/v2/checkout/orders`, `/capture`, `/v2/payments/captures/{id}/refund`, `/v1/notifications/verify-webhook-signature`). Field constraints (invoice_id <= 127 and unique per merchant, custom_id <= 255, item quantity as a string, item_total = sum of items) were checked against PayPal's published Orders v2 OpenAPI schema. 422 issue codes (INSTRUMENT_DECLINED, ORDER_ALREADY_CAPTURED, ORDER_NOT_APPROVED) follow PayPal's troubleshooting guidance: declined -> release budget and offer re-request; already captured -> GET the order to confirm instead of assuming; not approved -> stay pending.
- **Idempotency:** `PayPal-Request-Id` on create, capture and refund (keys derived from the purchase id), plus a unique `invoice_id` per order, plus an atomic `pending -> capturing` DB claim so a double-click cannot double-capture.
- **Amount verification:** after capture the server compares PayPal's captured amount and currency with the expected value; a mismatch marks the purchase `failed` and is audited rather than trusted.
- **Webhooks:** verified through PayPal's `verify-webhook-signature` endpoint using the *raw request bytes* embedded verbatim (re-serialising would break the signature). Idempotent on event id; tolerant of ordering (a webhook can finish a capture the browser never reported); amount-checked. Disabled with a clear 503 when `PAYPAL_WEBHOOK_ID` is unset - the capture response remains the source of truth.
- **`PAYPAL_MODE=mock`:** an in-process simulator of the endpoints above (including failure modes) used for offline development and automated tests. It is only mounted when explicitly selected, and **live mode is deliberately unsupported** (config refuses any value except `sandbox`/`mock`; the API base is hard-coded to the sandbox host).
- **Claude model:** default `claude-opus-5-5` (configurable via `ANTHROPIC_MODEL`), effort `low` for snappy tool loops, manual tool loop so every tool call is routed through our policy gate. Assistant turns are replayed unchanged inside a loop; only plain text is persisted between turns. I did not enable the beta server-side refusal fallback; a refusal or API error degrades to a polite message or the offline agent.
- **AG Grid Community, vendored from npm** and served from `/vendor/ag-grid` instead of a CDN, so the demo works offline and cannot break on a CDN outage.
- **Security posture:** secrets only in env vars (`.env` git-ignored, `.env.example` provided); HttpOnly + SameSite=Lax cookie; mutating endpoints require `application/json` (blocks cross-site form posts); 16 KB body limit; per-session and global rate limits on the AI endpoint; all UI text rendered via `textContent`; session-scoped queries everywhere (tested). No strict CSP because PayPal's SDK loads scripts/frames from several origins; kept `X-Frame-Options: DENY` and `nosniff` instead.
- **Hosting:** Render free tier via `render.yaml`; DB at `/tmp` (ephemeral by design, the seed recreates everything and stale cookies just start a fresh session). Free instances sleep after idle time, so the first request can be slow: warm the URL before recording or judging.

## Added after the first review
- **MCP server, hand-written JSON-RPC over Streamable HTTP (stateless, JSON responses)** instead of depending on the MCP SDK at runtime: the surface is three tools, it keeps the runtime dependency list small, and every message path is under test. The official `@modelcontextprotocol/sdk` is a **dev dependency only**, used by `test/mcp.test.js` as an independent conformance check (initialize, list, call). SSE streaming and sessions are declined (`GET`/`DELETE` -> 405), which the spec allows.
- **MCP auth = per-session bearer token**, stored as a sha256 hash, shown once, rotating, revocable. An external agent therefore acts on exactly one demo mandate, and purchases it requests still need the human's PayPal approval in the web UI. No Origin check: the endpoint is token-gated and browsers cannot know the token.
- **Pace limit and expiry** added to the mandate because "spending authority" should be time- and rate-bounded. Pace counts requests that passed policy in the last hour (blocked/failed ones don't count against the agent, but declined/cancelled ones do, so create-cancel loops are throttled). `NULL` = unlimited / never expires; existing databases migrate additively.
- **Agent activity trace** instead of token streaming: every tool call and policy outcome is returned and stored per reply and rendered in an expandable list. Honest, simple, and good for the demo; real streaming can come later.
- **Rules compliance** is tracked in [docs/RULES_CHECKLIST.md](docs/RULES_CHECKLIST.md) against the Official Rules (public repo + visible license, <3 min public YouTube video, testing access through Dec 15 with sandbox credentials in the instructions, no third-party marks/music in the video).

- **Catalog search rewritten after probing 13 free-form prompts**: the first version matched substrings ("desk" -> plant, "mouse" -> desk mat, "lamps" -> nothing). It now normalises plurals and a few synonyms, ignores filler words, scores name/tag hits plus a head-noun bonus, and refuses weak (description-only) matches, so "standing desk" correctly returns nothing. One function serves Claude's `search_catalog`, the offline agent and MCP, and `test/search.test.js` locks the behaviour in.
- **Accessibility:** an axe-core audit (WCAG 2.2 AA + best practices) of the main page, edit dialog and connect dialog found low-contrast text and a landmark gap; both fixed, now 0 violations. Not covered: manual screen-reader testing and the PayPal popup itself.
- **`npm run smoke -- <url>`** verifies a deployment end to end (including a real sandbox order, cancelled afterwards) so the owner can check the Render URL in one command.

## Things I could not do and why (read this)
- **Real PayPal sandbox: partially verified.** After the owner supplied sandbox credentials (kept in the git-ignored `.env`), I ran against `api-m.sandbox.paypal.com`: OAuth token OK; `POST /v2/checkout/orders` OK (status CREATED, approve/capture links returned); `GET` order shows the exact server-side amount; capturing an unapproved order returns 422 `ORDER_NOT_APPROVED`, which the app maps correctly; and in a headless browser the real PayPal JS SDK rendered a "Pay with PayPal" button per pending purchase (`env=sandbox`, `intent=capture`) with no console errors. **Not yet verified against PayPal:** the buyer login + approval popup, a successful capture, refund, and webhook signature verification (needs a sandbox buyer login and a webhook id). Those paths are covered by the simulator tests only. Do one full run before recording.
- **Claude path verified against a stub, not the live API** (no key available): tool loop, request shape and fallback are tested; model behaviour/quality is not.
- **Not deployed to Render and no demo video recorded** (needs the owner's Render account and a screen recording; see README and DEMO_SCRIPT.md).
- Sponsor tools other than AG Grid and Render hosting (APIMatic, Bryntum, Channel3, Postman, Zapier, Elastic, KERNEL, Astropods) were skipped: each adds integration surface and key requirements that do not improve the core demo.
- PayPal's Agent Toolkit / MCP server was not used: the agent's tools are first-party and gated by the policy engine; routing money movement through a generic MCP tool would bypass the very guardrail this product demonstrates. Worth revisiting as "Mandate as an MCP server" (see What's next).
