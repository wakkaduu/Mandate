## Inspiration

AI agents are about to buy things for us, and the scary part isn't the shopping, it's the spending. Handing an agent a card number is a non-starter. Approving every single click defeats the point of having an agent. Payments already has a word for the middle path: a **mandate**, a standing authority with hard limits (think direct debit). Agents need the same thing: a budget, a cap, a list of what's allowed, and a human who keeps the final say.

PayPal already has the pieces that make this trustworthy: buyer-approved orders, server-side capture, refunds, and signed events. So the idea was to make PayPal the *trust layer* of agentic commerce, not a checkout button bolted on at the end.

## What it does

You set a mandate: a total budget, a per-purchase cap, the categories the agent may buy from, plus optional extras (a rolling daily limit, seller allow/block lists, an hourly pace limit and an expiry). There is no built-in amount. Until you choose one, the server refuses to search, chat or buy.

Then you tell the assistant what you need: *"Set up my desk: a lamp under $40, a mechanical keyboard and a 4K monitor."*

1. The agent searches the live web. The **server** opens each product page and reads the retailer's own price and category. The model never supplies either.
2. Each request meets a deterministic **policy engine** *before PayPal is ever called*. The 4K monitor is over the cap, so it is blocked with a reason and never touches PayPal.
3. Allowed requests become real **PayPal sandbox orders**, created server-side. You approve each one with the PayPal button, and the server captures and re-verifies the amount.
4. Every decision, including the blocked ones, lands in a live **AG Grid** ledger with a full audit trail. Purchases can be refunded (two steps, with a cooling-off delay).

The assistant can only *suggest* changes to your limits, and you apply them. Mandate is also an **MCP server**, so any outside agent (Claude Code, for example) shops through the same policy gate, and you still approve every purchase in PayPal.

## How we built it

The design rule is a separation of powers: **the model proposes, policy disposes, the human consents, PayPal settles, and the ledger remembers.**

- **Policy engine:** pure functions, so it is easy to test and can't be argued with. With budget \\(B\\), per-purchase cap \\(C\\), daily limit \\(L\\), unit price \\(p\\) and quantity \\(q\\), the committed spend is the sum over purchases that are reserved, pending, capturing or captured:

  $$ R = B - \sum_{i \in \mathcal{A}} a_i, \qquad \mathcal{A} = \{\text{reserving},\ \text{pending},\ \text{capturing},\ \text{captured}\} $$

  and a request is allowed only if the non-numeric checks pass (expiry, category, seller, duplicate) and

  $$ pq \le C \;\;\wedge\;\; pq \le R \;\;\wedge\;\; pq + D \le L \;\;\wedge\;\; n < N $$

  where \\(D\\) is what was committed in the last 24 hours and \\(n\\) is the number of requests in the last hour (limit \\(N\\)). Because pending orders count against \\(R\\), an agent can't over-commit by queueing many small ones. Check and reservation run in one write transaction, so two concurrent proposals can't both fit into the same remaining budget. That makes \\(\sum_{i \in \mathcal{A}} a_i \le B\\) true at the moment of every reservation, and even if you approve everything, a rolling day can't exceed \\(\min(B, L)\\).
- **The model can't speak in money.** `propose_purchase` takes an `offer_id` and a quantity, so the amount is \\(a = p(\text{offer}) \cdot q\\), where \\(p\\) was read by the server from the retailer's page. Prices are stored as integer cents, since \\(0.1 + 0.2 \neq 0.3\\) in floating point, and only formatted as `"34.00"` at the PayPal boundary.
- **PayPal as the trust layer:** Orders v2 created server-side with `PayPal-Request-Id` idempotency and a unique `invoice_id`; the JS SDK button hands PayPal our server-created order id; capture is server-side with the amount and currency re-verified; refunds use the captures API; webhooks are checked with `verify-webhook-signature` against the raw request bytes, deduplicated by event id.
- **Agent:** a Gemini function-calling loop (Claude also supported) with model fallback and quota cool-downs, running the same tool layer as the **MCP server** (Streamable HTTP, hashed bearer tokens). The MCP server is tested with the official MCP SDK client.
- **Hardening:** SSRF-safe page fetching, a CSP with per-request nonce, typed confirmation for high-value payments, confirmation for anything that *raises* spending power, spreadsheet-safe CSV exports.
- **Stack:** Node + Express, libSQL (SQLite file locally, Turso on serverless), a vanilla JS front end and AG Grid Community vendored from npm. 89 automated tests cover the policy, the live-web pipeline, the whole payment lifecycle against an in-process PayPal simulator, webhooks, both agent loops and MCP.

I built it solo, using Claude Code as my coding assistant, and kept a decision log (`DECISIONS.md`) of every trade-off along the way.

## Challenges we ran into

- **Making "the AI can't overspend" a guarantee, not a prompt.** A system prompt is a request, not a control. Every limit runs server-side after the model has spoken, and I tested it against a prompt-injection attempt to split a purchase and dodge the cap.
- **Real prices are hard.** My first version used a small catalog, which made the demo feel fake. Moving to live web search meant trusting nothing a search API or model says about price. Probing real retailers showed that many large marketplaces hide prices from static HTML or block automated reads. The server therefore skips what it can't verify instead of guessing, which means coverage is mostly independent and direct-to-consumer stores.
- **Free-tier quotas.** Gemini's per-model daily limits ran out during testing. The fixes were a fallback chain across models, cool-downs on quota errors, cached searches, and a "search the web yourself" panel that runs the same verified-offer pipeline without any model, so the app still works when the model doesn't.
- **PayPal details that bite.** Webhook verification needs the exact bytes PayPal sent, so re-serialising JSON breaks it. PayPal's own SDK injects an inline script that my first strict CSP blocked (found with the real SDK in headless Chromium, fixed with a nonce). A double-click, a lost capture response, a declined funding source and a webhook that beats the browser each needed an explicit, tested path.
- **Feedback that changed the product.** "It feels not real, the mandate is already fixed at $300." A spending control can't start with someone else's number, so new sessions now have no mandate at all and the server refuses everything (`409 MANDATE_NOT_SET_UP`) until the owner sets one.

## Accomplishments that we're proud of

- A clean separation of powers where each actor is trusted with only what it can't abuse. The model can pick among verified offers, but it can't set a price, a category or a limit.
- Blocked purchases are first-class, visible events, which is the observability agent builders actually need.
- The unglamorous paths are tested, not just the happy one: decline, cancel, expire, duplicate capture, lost response, refund, forged and replayed webhooks.
- It stays honest. If the AI is unavailable, the app says so and buys nothing. I deleted a scripted "offline shopper" because pretending to shop is worse than admitting it can't.

## What we learned

Most of a "safe agent" is ordinary engineering (transactions, idempotency keys, audit logs, input validation) rather than model cleverness. The best safety lever was **tool design**: when the agent's only way to spend is `offer_id` plus a quantity, there is no price field left to manipulate. PayPal's Orders API fits agentic commerce well. Server-created orders with idempotency give an agent a safe way to *request* money movement, and buyer approval is a natural consent point.

I also learned to be strict about what is verified. Against the real PayPal sandbox I've confirmed order creation and lookup, the not-approved error path and the SDK buttons rendering for agent-created orders. The refund and signed-webhook paths are covered by the simulator suite, and PayPal's popup rejects automated browsers, so the buyer-approval step gets checked by hand.

## What's next for Mandate

- **Delegated auto-approval for small purchases** using PayPal Vault / billing agreements, so the cap becomes real spending authority and only larger purchases need a tap.
- **Authorize-then-capture for high-value purchases**, to hold funds first and capture only once the order is confirmed.
- **Multi-user MCP:** OAuth instead of per-session tokens, team mandates with shared budgets, and spend analytics.
- **Wider merchant coverage** through real merchant feeds, so large retailers become verifiable instead of skipped, plus shipping addresses and multi-currency.
- Confirming refunds and signed webhooks against the live PayPal sandbox end to end.
