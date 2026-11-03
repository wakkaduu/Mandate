# Mandate - spend rails for AI shopping agents, settled by PayPal

Give an AI agent a **spending mandate** (budget, per-purchase cap, allowed categories). It shops for you; a policy engine approves or blocks every request *before PayPal is called*; allowed purchases become real **PayPal sandbox orders** that you approve with one tap; every decision lands in a live **AG Grid** ledger. Built for the PayPal AI Hackathon.

![Agent proposes purchases and the mandate blocks one](docs/screenshots/01-agent-proposes.png)

## How PayPal is used (it is the trust layer, not a checkout button)
| Step | PayPal API | Where |
|---|---|---|
| Agent's approved request becomes an order, **server-side**, amount from the DB (never the client/LLM), `PayPal-Request-Id` idempotency + unique `invoice_id` | `POST /v2/checkout/orders` | [src/paypal.js](src/paypal.js) |
| Human approves the order in the PayPal popup | PayPal JS SDK Buttons (`createOrder` returns our server-created order id) | [public/app.js](public/app.js) |
| Server captures, then verifies amount/currency; duplicate captures are confirmed via `GET` | `POST /v2/checkout/orders/{id}/capture`, `GET /v2/checkout/orders/{id}` | [src/purchases.js](src/purchases.js) |
| Declined / cancelled / expired / not-approved / already-captured / transient failures handled | 422 issue codes | [src/purchases.js](src/purchases.js) |
| Undo a purchase | `POST /v2/payments/captures/{id}/refund` | [src/purchases.js](src/purchases.js) |
| Async truth: signed events, idempotent on event id | `POST /v1/notifications/verify-webhook-signature`; `PAYMENT.CAPTURE.COMPLETED / DENIED / REFUNDED` | [src/server.js](src/server.js) |

Sandbox only: the config refuses to run against anything but the sandbox host.

## How the AI is used
A Claude tool-use loop (`search_catalog`, `propose_purchase`, `get_mandate`) decides *what* to buy. It cannot move money or override rules: `propose_purchase` goes through [src/policy.js](src/policy.js) (category, per-purchase cap, remaining budget including pending reservations, duplicate guard). Without an `ANTHROPIC_API_KEY`, a deterministic offline agent uses the same tools and gate, so the app always demos. The UI shows which brain is active, and each reply has an expandable **agent activity** trace (every tool call and policy outcome).

### Bring your own agent (MCP)
Mandate is also an **MCP server** (Streamable HTTP at `/mcp`). Click **Connect an agent**, generate a token, and any MCP client can use the same rails:
```bash
claude mcp add --transport http mandate https://<your-host>/mcp --header "Authorization: Bearer mnd_..."
```
Tools: `search_catalog`, `propose_purchase`, `get_mandate`. The external agent can only *request* purchases; the policy engine decides, and you approve each one with PayPal in the web UI. The token is stored hashed and can be revoked. The endpoint is tested with the official MCP SDK client (`test/mcp.test.js`).

### The mandate
Budget, per-purchase cap, allowed categories, **pace limit** (max purchase requests per hour) and optional **expiry**. Checks run in this order: active -> category -> duplicate -> cap -> budget -> pace.

## Quick start

Requirements: Node 22.13+ (tested on Node 24).

```bash
git clone <this repo> && cd <repo>
npm install
cp .env.example .env        # then fill in values (see below)
npm start                   # http://localhost:3000
```

`npm start` loads `.env` automatically (via `node --env-file-if-exists`); you can also just export the variables in your shell.

### Option A - no credentials at all (offline simulator)
```bash
PAYPAL_MODE=mock npm start
```
Uses an in-process PayPal simulator and the offline agent. Good for a 30-second look and for the test suite. The "Approve with PayPal (simulated)" and "Simulate declined card" buttons stand in for the PayPal popup.

### Option B - real PayPal sandbox (what the demo video uses)
1. Go to <https://developer.paypal.com/dashboard/applications/sandbox> (free account), **Create App** (Merchant type), and copy the **Client ID** and **Secret**.
2. Under **Testing tools -> Sandbox accounts**, use the default **Personal** (buyer) account. Its email/password are shown there ("View/edit account"); you log in with those in the PayPal popup. Do not use a real PayPal account.
3. Set in `.env`:
   ```
   PAYPAL_MODE=sandbox
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   ```
4. (Optional) Webhooks: in the app's settings add a webhook pointing at `https://<public-host>/api/paypal/webhook` for `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, then set `PAYPAL_WEBHOOK_ID`. Locally you need a tunnel (e.g. ngrok); on Render use the service URL. Without it, the app still works: the capture response is the source of truth.
5. (Optional) AI: set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`, default `claude-opus-5-5`).

### Environment variables
| Variable | Required | Purpose |
|---|---|---|
| `PAYPAL_MODE` | yes | `sandbox` (default) or `mock`. Live is unsupported by design. |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | sandbox mode | Sandbox REST app credentials |
| `PAYPAL_WEBHOOK_ID` | no | Enables the verified webhook endpoint |
| `ANTHROPIC_API_KEY` | no | Enables the Claude agent (else offline agent) |
| `ANTHROPIC_MODEL` | no | Default `claude-opus-5-5` |
| `PORT`, `DATABASE_PATH`, `PUBLIC_URL` | no | Server settings |

### Try this demo script
1. Click the first suggestion chip: *"Set up my desk: a lamp under $40, a mechanical keyboard and a 4K monitor"*.
2. See the lamp and keyboard queued under **Approvals** and the 4K monitor **blocked** (over the $120 cap) with a reason and an alternative.
3. Approve the lamp with the PayPal button (sandbox buyer login). Watch the budget bar and the ledger update.
4. Click **Edit** on the mandate, raise the cap, then ask for the monitor again. Dismiss or decline another order to see the budget release; **Refund** a captured purchase to get funds back.
5. Open the **Audit trail** tab to see every policy decision and PayPal event.

## Tests
```bash
npm test
```
32 tests: policy unit tests (incl. expiry and pace); end-to-end flow tests (agent -> policy -> order -> approve -> capture, decline, cancel, refund, duplicate capture, budget reservations, session isolation, input validation, CSRF hardening, webhook signature/idempotency/amount-mismatch) against the in-process PayPal simulator; the Claude tool loop against a local stub of the Messages API; and the MCP server driven by the official MCP SDK client.

> Honest status: order creation, order lookup, the not-approved error and the PayPal JS SDK buttons are verified against the real PayPal sandbox; the buyer approval -> capture -> refund -> webhook path is verified against the simulator only. See [DECISIONS.md](DECISIONS.md) and run Option B end to end once before recording.

## Deploy (Render free tier)
1. Push to a public GitHub repo (the MIT [LICENSE](LICENSE) shows in the repo's About section).
2. Render -> **New -> Blueprint** -> select the repo ([render.yaml](render.yaml)).
3. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, optionally `PAYPAL_WEBHOOK_ID` and `ANTHROPIC_API_KEY` in the dashboard.
4. Add the webhook in the PayPal dashboard pointing at `https://<service>.onrender.com/api/paypal/webhook`.
5. Open the URL (the free instance sleeps when idle; first load can take ~30s) and run the demo script.

## API
See [docs/API.md](docs/API.md) for the endpoint contract and the single error envelope.

## Project layout
```
src/server.js      Express app, routes, sessions, webhook endpoint
src/purchases.js   Purchase state machine, audit log, PayPal reconciliation
src/policy.js      Mandate policy engine (pure functions)
src/paypal.js      PayPal REST client (orders, capture, refund, webhook verify)
src/agent.js       Claude tool loop + offline agent
src/tools.js       Tool surface shared by Claude, the offline agent and MCP
src/mcp.js         MCP server (Streamable HTTP, bearer-token auth)
src/mock-paypal.js In-process PayPal simulator (mock mode / tests only)
src/db.js          SQLite schema + seed
public/            Vanilla JS UI + AG Grid ledger
test/              node:test suites
```

## Screenshots
| | |
|---|---|
| ![Approved and declined](docs/screenshots/02-approved-and-declined.png) | ![Mobile](docs/screenshots/03-mobile.png) |

## Official Rules
Compliance checklist: [docs/RULES_CHECKLIST.md](docs/RULES_CHECKLIST.md).

## License
MIT - see [LICENSE](LICENSE).
