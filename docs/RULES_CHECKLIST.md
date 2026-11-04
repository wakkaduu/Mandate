# Official Rules compliance checklist

Source: *PayPal AI Hackathon Official Rules* (Devpost). Submission period: **Oct 1, 2026 9:15 am PT - Nov 12, 2026 12:00 pm PT**. Judging: Dec 1 - Dec 15, 2026. Status: DONE = in the repo, TODO = owner action, WATCH = keep an eye on it.

| # | Rule (section) | Status | Evidence / action |
|---|---|---|---|
| 1 | Build an app that integrates the PayPal developer platform **using the free sandbox**, with an AI tool/model; PayPal integration must be central (4, Project Requirements; Stage 1 pass/fail, 6) | DONE | Orders v2 create/capture/refund, JS SDK approval, webhooks, all sandbox-only (`src/config.js` refuses non-sandbox hosts). AI: Gemini function-calling agent (Claude supported) + MCP server |
| 2 | Project is new, or significantly updated during the period (4) | DONE | Created Nov 3, 2026 (inside the period); git history shows it |
| 3 | Functional demo (verify a deployment with `npm run smoke -- <url>`): judges can run it from repo instructions **or** a hosted URL; mockups don't count (4, Submission Requirements) | DONE / TODO | README has complete run instructions incl. a no-credentials `PAYPAL_MODE=mock` path. TODO: also deploy the hosted URL on Render |
| 4 | Public code repo (GitHub/Bitbucket/GitLab) with **all** source, assets and instructions (4) | DONE | https://github.com/wakkaduu/Mandate is public (verified Nov 3 via the GitHub API) |
| 5 | Repo is open source with a license **visible in the About section** (4) | DONE | GitHub detects the MIT license (`license: MIT` in the repo API); add a repo description and topics in About for polish |
| 6 | Text description of features and functionality (4) | DONE | `SUBMISSION.md` |
| 7 | Demo video < 3 min, public on YouTube, shows the project working on its device, **no third-party trademarks or copyrighted music** (4) | TODO | `DEMO_SCRIPT.md` is timed to ~2:45, no music; show only PayPal's own buttons, the sponsor tools and the app itself. Do not show other brands' logos |
| 8 | Third-party SDKs/APIs: be authorized under their terms (4) | DONE | Express (MIT), Anthropic SDK (MIT), AG Grid Community (MIT), MCP SDK (dev-only, MIT), PayPal REST/JS SDK used under PayPal developer terms, sandbox only |
| 9 | Submission is original work, solely owned, no IP violations (4, 7) | DONE | Written for this event; dependencies are permissively licensed; products come from live web search (only a link and a server-read price are stored; no third-party images or text are copied) |
| 10 | No financial/preferential support from Sponsor or Administrator (4) | DONE | None received |
| 11 | **Testing access free of charge and unrestricted for Sponsor/Administrator/Judges until the Judging Period ends (Dec 15)**; include test credentials/sandbox logins needed (4, Testing) | TODO / WATCH | Put the sandbox **buyer** login in the Devpost testing instructions (the local `accounts` file holds them; it is git-ignored and was removed from the repo on Nov 4, so do not re-add it) (see `SUBMISSION.md`, "Testing instructions"). Keep the Render service and your PayPal sandbox app alive through Dec 15; keep an Anthropic key spend cap on the demo; the offline agent keeps the app usable if the key runs out. Free Render instances sleep: say so in the instructions |
| 12 | All materials in English (4) | DONE | |
| 13 | Team/individual eligibility, age of majority, not a sanctioned region, not a Sponsor/Administrator employee or relative (3) | TODO | Owner to confirm eligibility |
| 14 | Submit via Devpost before the deadline; no edits after the period ends (4, 5) | TODO | Submit **Nov 11**, a day early. After Nov 12 12:00 pm PT nothing can change |
| 15 | Each submission unique; multiple allowed (4) | DONE | One submission |
| 16 | Prize rules: sponsor prizes need use of that sponsor's tools (8) | DONE / TODO | AG Grid Community powers the ledger (AG Grid prize). Render prize: deploy on Render and say so in the write-up. One Grand/Honorable prize + one Sponsor prize max |
| 17 | Judging criteria: Technological Implementation, Design, Potential Impact, Innovation, Presentation (6) | DONE | Mapped below |
| 18 | Winner verification, W-9/W-8BEN, taxes (8) | n/a now | Be ready to prove authorship if you win |
| 19 | Publicity: sponsor may use name/likeness/Submission for promotion (7, 10) | NOTE | Don't put anything private in the video or repo |
| 20 | No malicious code/viruses (7) | DONE | Small readable codebase; `npm audit` clean |

## Criteria map (Stage 2, equally weighted)
- **Technological Implementation:** server-side Orders v2 with idempotency + unique invoice ids, capture verification, refunds, signed webhooks, atomic budget reservations, Gemini/Claude tool loop over live web search with server-side price verification (SSRF-hardened page fetch, server-assigned categories, mandate pre-check), MCP server (conformance-tested with the official SDK client), a search-it-yourself path that works without the AI, 49 automated tests.
- **Design:** a four-step "how it works" strip, live budget bar, per-purchase policy checklists, agent-activity trace, full state coverage (blocked/declined/cancelled/expired/refunded), responsive and keyboard-friendly.
- **Potential Impact:** a specific problem (letting agents spend without handing them a card) for a real audience (anyone deploying shopping/procurement agents), with PayPal as the consent and settlement layer.
- **Innovation:** policy-gated delegated spending plus an MCP surface so any agent can use the same rails.
- **Presentation:** `DEMO_SCRIPT.md` (end-to-end flow, under 3 minutes) and `SUBMISSION.md`.
