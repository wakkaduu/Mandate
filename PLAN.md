# PLAN - Mandate

> Hackathon: PayPal AI Hackathon (Devpost). Submission period ends **Thu Nov 12, 2026, 12:00 pm PT**. Judging criteria (equal weight): Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation. Stage 1 is pass/fail on "PayPal integration is central + AI tool used".

## Product summary
**Mandate** lets a person give an AI shopping agent a *spending mandate* (budget, per-purchase cap, allowed categories). The agent searches a catalog and requests purchases. A deterministic policy engine approves or blocks every request **before PayPal is ever called**. Approved requests become real PayPal orders created server-side; the human approves each with one tap on the PayPal button, the server captures, and a live ledger (AG Grid) records every decision, including blocked ones.

The pitch: *agents are about to spend money on our behalf; PayPal is the trust layer that makes it safe.* Autonomy for the agent, consent for the human, receipts for everyone.

### Demo flow judges see (about 90 seconds)
1. Mandate card: "Home office refresh", $300 budget, $120 cap, categories office/electronics/home.
2. Type: *"Set up my desk: a lamp under $40, a mechanical keyboard and a 4K monitor."*
3. Agent queues lamp ($34) + keyboard ($89); **blocks** the 4K monitor ($429 > $120 cap) and offers an in-policy alternative. Blocked item never touches PayPal.
4. Approvals column shows two PayPal buttons. Approve the lamp in the PayPal sandbox popup; the order is captured server-side; budget bar turns green.
5. Decline / cancel path: a declined card releases the budget and offers "Re-request".
6. Ledger (AG Grid): purchases + full audit trail (policy decision, order id, capture id, webhook confirmation). Refund the lamp: budget is restored.

## Scope
**Must-have (done)**
- Mandate (view/edit) with server-enforced policy: category, per-purchase cap, remaining budget (counts reservations), duplicate guard, quantity limits.
- Agent chat: Claude tool-use loop (search_catalog, propose_purchase, get_mandate) + deterministic offline agent behind the same tools.
- PayPal Orders v2: create (server-side prices, idempotency key, unique invoice_id), JS SDK approval, server capture, GET order verification on duplicate capture.
- Failure handling: declined instrument, cancelled approval, expired order, duplicate capture, amount mismatch, transient errors.
- Webhooks with signature verification (verify-webhook-signature), idempotent on event id: PAYMENT.CAPTURE.COMPLETED / DENIED / REFUNDED.
- Refund of a captured purchase.
- Ledger with AG Grid (purchases + audit trail). Per-visitor isolated demo sessions with seeded catalog + mandate.
- Tests: policy unit tests, full-flow integration tests against a PayPal simulator, Claude loop test against an API stub.

**Nice-to-have (done)** mandate editor, re-request, reset demo, responsive layout, rate limiting, **pace limit + expiry rules, agent-activity trace, and Mandate as an MCP server** (so any agent can use the same rails; added Nov 3 after review).

**Cut** user accounts/auth, PayPal Vault / auto-approve of small purchases (requires billing agreements; human approval is the point of the demo), multi-currency, shipping addresses, real merchant feeds (Channel3), PayPal Agent Toolkit/MCP integration (see DECISIONS), Postman/APIMatic/Zapier tie-ins.

## Tech stack
| Choice | Why |
|---|---|
| Node 22.13+/24, Express | One small server, no build step, deploys on any free host |
| libSQL (`@libsql/client`): SQLite file locally/Render, Turso on Vercel | One async code path; transactional budget reservations; serverless-ready |
| Vanilla JS front end | No bundler; fewer moving parts; fast to polish |
| PayPal REST (Orders v2, Payments refund, Webhooks verify) via `fetch` | Exactly the documented endpoints, no SDK guesswork |
| PayPal JS SDK Buttons | The human-approval moment; order id comes from our server |
| Gemini API (function calling) with Claude as an alternative | Real LLM agent loop; provider/model configurable via env, with model fallback |
| AG Grid Community (vendored from npm) | Ledger/audit grid with sort/filter; eligible for the AG Grid sponsor prize |
| Render free tier (`render.yaml`) | Free host with a blueprint; eligible for the Render sponsor prize |

## Architecture
```
Browser (chat, mandate, approvals, AG Grid)
   |  JSON + session cookie
Express API ---------------------------------------------------------+
   |-- agent.js  --(Claude tool loop | offline agent)--> tools         |
   |        search_catalog / get_mandate / propose_purchase            |
   |-- policy.js  <-- every proposal (pure functions)                  |
   |-- purchases.js (state machine + audit log, SQLite)                |
   |-- paypal.js ---> PayPal sandbox: oauth, create order, capture,    |
   |                  get order, refund, verify-webhook-signature      |
   '-- /api/paypal/webhook <--- PayPal events (raw body verified) -----+
Human approves in the PayPal popup (JS SDK) -> browser calls /capture -> server captures
```
PayPal sits at three points: (1) order creation, only after the policy passes; (2) buyer approval and server-side capture; (3) webhooks as the source of truth for asynchronous state and refunds.

Purchase state machine: `reserving -> pending -> capturing -> captured -> (refunding -> refunded)`; terminal side exits: `blocked`, `declined`, `cancelled`, `expired`, `failed`. Budget committed = reserving + pending + capturing + captured + refunding.

## Database schema (SQLite)
- `sessions(id, created_at)`
- `products(id, name, merchant, category, price_cents, tags, description, emoji)` - seeded
- `mandates(session_id PK, name, budget_cents, per_item_cap_cents, categories JSON, updated_at)`
- `purchases(id, session_id, product_id, product_name, merchant, category, qty, amount_cents, status, reason, rationale, paypal_order_id, paypal_capture_id, paypal_refund_id, payer_email, created_at, updated_at)`
- `audit(id, session_id, purchase_id, type, detail, created_at)`
- `messages(id, session_id, role, content, created_at)`
- `webhook_events(event_id PK, event_type, received_at)` - idempotency for webhooks

## Milestones (Nov 3 -> Nov 12 noon PT)
| When | Milestone | Exit check |
|---|---|---|
| Nov 3 | M1 vertical slice: chat -> policy -> PayPal order -> approve -> capture -> ledger (simulator) | Integration tests green |
| Nov 3 | M2 failure paths, webhooks, refund, Claude loop, AG Grid, UI polish | 34 tests green (grew through the day), UI walkthrough clean |
| Nov 4 | M3 **Run against the real PayPal sandbox** with sandbox credentials; fix any API drift | Full demo flow with sandbox buyer account |
| Nov 5 | M4 Deploy to Render, configure webhook + `PAYPAL_WEBHOOK_ID`, rerun demo on the live URL | Live URL demo passes |
| Nov 6-7 | M5 Screenshots, README/SUBMISSION polish, record + edit video (<3 min) | Video uploaded public on YouTube |
| Nov 8-10 | Buffer: bugs, re-record, make repo public with license visible | Repo public, license in About |
| Nov 11 | Final submission on Devpost (a full day early) | Submission visible |
| Nov 12 | Reserve only; deadline 12:00 pm PT | - |
