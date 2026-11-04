# Mandate - Devpost submission

**Tagline:** Spend rails for AI shopping agents - policy-checked, PayPal-approved, fully audited.

**Links:** Repo: https://github.com/wakkaduu/Mandate - Live demo: `<Render URL>` - Video: `<YouTube URL>` (see DEMO_SCRIPT.md)

**Built with:** PayPal REST (Orders v2, Payments refund, Webhooks), PayPal JS SDK, Google Gemini (function calling; Claude also supported), Model Context Protocol (MCP), AG Grid Community, Node.js, Express, SQLite, Render.

**Prizes targeted:** Grand Prize, Best Use of PayPal + AI, Best Use of Agentic Commerce, Best Use of AG Grid, Best Use of Render.

**AI tool:** Google Gemini via the Gemini API (function calling) reads the user's request and decides what to buy; PayPal's sandbox settles every approved purchase.

## Inspiration
AI agents are about to buy things for us, and the scary part is not the shopping, it is the spending. Handing an agent a card number is a non-starter, and approving every single click defeats the point of an agent. We wanted the middle path: give the agent a *mandate* with hard limits, let it work freely inside them, and keep a human tap on the money. PayPal already has the pieces that make this trustworthy: buyer-approved orders, server-side capture, refunds and signed events.

## What it does
You set a mandate: a budget, a per-purchase cap, allowed categories, a pace limit (requests per hour) and an optional expiry. You tell the agent what you need ("a lamp under $40, a mechanical keyboard and a 4K monitor"). For each item the agent searches the live web for real products and requests a purchase. A policy engine decides instantly:
- **Allowed** requests become real PayPal sandbox orders, and a PayPal button appears for you to approve. The server captures, verifies the amount, and your budget bar updates.
- **Blocked** requests (over the cap, over budget, wrong category, duplicate) never reach PayPal. The agent explains why and offers an in-policy alternative.

Every reply has an expandable "agent activity" trace, and Mandate is also an **MCP server**: connect Claude Code (or any MCP agent) and it shops through the same policy gate, with you approving each purchase in PayPal.

Everything lands in an AG Grid ledger with a complete audit trail: policy decisions, order ids, capture ids, webhook confirmations, refunds. Declined cards, cancelled approvals, expired orders and double clicks are all handled, and any captured purchase can be refunded with one click.

## How we built it
- **Policy engine** (`policy.js`): pure functions for expiry, category, duplicate, per-purchase cap, remaining budget (pending reservations count, so an agent cannot over-commit by queueing orders) and hourly pace. The LLM cannot override it.
- **Agent**: a Gemini (or Claude) tool-use loop with `search_products` (live web search: Tavily/Serper/Gemini find candidate pages, then the *server* opens each product page and reads the retailer's price and category, and pre-checks each offer against the mandate), `propose_purchase` (by offer id only, the model cannot set a price) and `get_mandate`. An **MCP server** (Streamable HTTP, bearer-token auth, tested with the official MCP SDK client) share the same tools and gate, so any outside agent can use the rails.
- **PayPal**: orders are created server-side from server-verified web prices with `PayPal-Request-Id` idempotency and a unique `invoice_id`; the JS SDK button hands the server-created order id to PayPal; capture is server-side and the captured amount/currency is re-verified; refunds use the captures API; webhooks are verified with PayPal's `verify-webhook-signature` against the raw request bytes, deduplicated by event id, and can finish a capture the browser never reported.
- **Works without the AI too**: a "search the web yourself" panel runs the same verified-offer pipeline, mandate pre-check and PayPal approval, so the demo survives model rate limits.
- **Ledger**: AG Grid with sorting/filtering over purchases and the audit trail.
- **Stack**: Node + Express, built-in `node:sqlite`, vanilla JS front end, Render free tier. automated tests cover the policy, the live-web pipeline (price verification, SSRF guard), the full payment lifecycle against a PayPal simulator, webhooks, the Claude tool loop and the MCP server (driven by the official MCP client).

## Challenges
- Making "the AI can't overspend" a *guarantee* instead of a prompt: the cap, budget and category rules run server-side after the model speaks, and reservations are taken inside a transaction so concurrent proposals cannot both fit into the same remaining budget.
- Payment edge cases: a double-click on approve, a capture response lost in transit, a declined funding source, and a webhook that arrives before the browser's capture call. Each has an explicit, tested path.
- Webhook verification needs the exact bytes PayPal sent, so the payload is embedded verbatim rather than re-serialised.
- Keeping the demo reliable for every judge: per-visitor sessions with seeded data, an honest 'AI unavailable' reply instead of a fake shopper, vendored AG Grid so nothing depends on a CDN.

## Accomplishments we're proud of
- A real separation of powers: the model proposes, deterministic policy disposes, the human consents, PayPal settles, and the ledger remembers.
- Blocked purchases are first-class, visible events, which is exactly the observability agent builders need.
- The whole payment lifecycle (approve, decline, cancel, expire, duplicate, refund, webhook) is covered by automated tests, not just the happy path.

## What we learned
PayPal's Orders API fits agentic commerce well: server-created orders with idempotency keys give agents a safe, auditable way to *request* money movement, and the approval step is a natural place for consent. We also learned how much of a "safe agent" is ordinary engineering (transactions, idempotency, audit logs) rather than model cleverness.

## What's next
- **Auto-approve for small purchases** with PayPal Vault / billing agreements, turning the mandate's cap into real delegated spending authority.
- Pair the MCP server with PayPal's Agent Toolkit, plus OAuth-based MCP auth for multi-user deployments.
- Real merchant feeds (e.g. Channel3), shipping addresses, multi-currency, team mandates with shared budgets, and spend analytics.

## Testing instructions (for judges)
**Hosted demo:** `<Render URL>` (free instance: the first load after idle can take about 30 seconds). Each visitor gets an isolated demo session with a pre-seeded mandate, so no sign-up is needed.

1. Click a suggestion chip, or type *"a desk lamp under $40, a mechanical keyboard and a 4K monitor"*. The agent searches the live web (each price is verified on the retailer's page by the server); the 4K monitor is blocked by the policy, the other items appear under **Approvals**. Open **Agent activity** to see each tool call. If the AI model is busy, use **Search the web yourself** (same checks, no model).
2. Click the PayPal button and sign in with this **PayPal Sandbox buyer** account (fake money, sandbox only):
   - Email: `<sandbox buyer email>`
   - Password: `<sandbox buyer password>`
3. Approve. The server captures the payment, the budget bar updates and the ledger records it. Try **Dismiss**, **Refund**, **Edit** (raise the cap) and the **Audit trail** tab.
4. Optional: open **Information** in the side panel for the MCP endpoint, and **How it works** for a one-page explanation. Settings lets you switch theme, accent color, density and motion.

**Run it yourself (no accounts needed):** `git clone`, `npm install`, `PAYPAL_MODE=mock npm start`, open http://localhost:3000. For the real PayPal sandbox, copy `.env.example` to `.env` and add sandbox credentials (README, Option B). Tests: `npm test`.

**Judging-period availability:** the demo and repository stay available, free and unrestricted, through Dec 15, 2026.
