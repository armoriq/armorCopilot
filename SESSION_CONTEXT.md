# ArmorCopilot — Session Context (start here in new sessions)

> **For a fresh Claude session:** read this file top-to-bottom before doing anything else. It's the single source of truth for what's been decided, what's been built, and what's next on ArmorCopilot. If anything below conflicts with what you see in the codebase, trust the codebase and update this file.

---

## 1. Project context

ArmorCopilot is the third product in the ArmorIQ enforcement lineup:

| Product | Harness | Repo | Status |
|---|---|---|---|
| **ArmorClaude** | Anthropic Claude Code | `/Users/hariharasudhan/Armoriq/armorClaude` | Live in marketplace |
| **ArmorCodex** | OpenAI Codex | `/Users/hariharasudhan/Armoriq/armorCodex` | Live + listed on `hashgraph-online/awesome-codex-plugins` |
| **ArmorCopilot** (NEW) | Microsoft Copilot Studio (later: GitHub Copilot CLI) | `/Users/hariharasudhan/Armoriq/armorCopilot` | PoC stub bootstrapped 2026-05-21 |

All three share the same conceptual model: intercept tool calls before they execute → match against a registered intent plan → consult ArmorIQ backend policy engine → block or allow → audit.

### Why now

Ketan (12:57 AM, 2026-05-21 in Slack): *"@Hari can you pick up ArmorCopilot Microsoft one"*

After clarifying, Ketan confirmed (5:58 PM, 2026-05-21): **Microsoft Copilot**, not GitHub Copilot.

---

## 2. Interception surface map (what we CAN and CAN'T do)

Research completed 2026-05-21. Snapshot of the extension surface across every Copilot product:

### Microsoft side

| Surface | Real interception? | Notes |
|---|---|---|
| **Microsoft Copilot Studio** | **YES** | `/analyze-tool-execution` external security webhook. Sub-1s inline block/allow. Same surface Check Point + Zenity already integrate. **THIS IS OUR TARGET.** |
| M365 Copilot (Teams/Outlook/Word) | NO | Only post-hoc audit via Purview + Office Management Activity API. No pre-execution hook. Audit-only SKU possible if a customer asks. |
| M365 declarative agents | NO | Manifest 1.6 has no pre-execution guard property. Only inherits Copilot Studio hooks if hosted there. |

### GitHub side

| Surface | Real interception? | Notes |
|---|---|---|
| **GitHub Copilot CLI** (`gh copilot`) | **YES** | Mature `preToolUse` / `postToolUse` hooks. ~85% code reuse from ArmorCodex. Deferred to Phase B (after MS MVP). |
| VS Code Copilot agent mode | NO (yet) | Proposed permission API (microsoft/vscode#302362), not GA. |
| JetBrains Copilot agent mode | NO (only MCP) | MCP server registration, no hooks. |
| GitHub Copilot Chat (web) | NO | Cloud-executed, no extension surface. |
| GitHub App Extensions | NO (deprecated) | Sunset 2025-11-10, replaced by MCP. |

### Out of scope (defer)

- M365 Copilot audit-only SKU
- VS Code agent mode (wait for permission API)
- JetBrains agent mode
- AppSource / Microsoft Partner Network listing (do after first customer)

---

## 3. Decisions made (2026-05-21)

| # | Decision | Rationale |
|---|---|---|
| 1 | Target Microsoft Copilot Studio for ArmorCopilot-MS | Only MS surface with real pre-execution interception |
| 2 | Skip M365 Copilot for now | No interception, only audit. Revisit if customer asks |
| 3 | Sequence: MS first, GH after MVP (not parallel) | Ketan specifically asked for Microsoft. GH is cheap (1 week) but parallelizing now splits attention |
| 4 | Host MS webhook in `conmap-auto` (not standalone service) | Reuses `IapPolicyDecisionService` + audit pipeline + auth. Existing endpoints already meet <1s budget |
| 5 | Multi-tenant via path param `/copilot-studio/analyze-tool-execution/:tenantId` | Each customer gets unique URL + HMAC secret |
| 6 | Defer shared-core library extraction (Phase C) | Don't refactor until ArmorCopilot ships + stabilizes |
| 7 | New monorepo `armoriq/armorCopilot` | Houses both `-ms` (server-side) and `-gh` (client-side plugin) packages |

---

## 4. What's done today (2026-05-21)

### Phase 0 — bootstrap

- **Repo:** github.com/armoriq/armorCopilot (private, cloned to `/Users/hariharasudhan/Armoriq/armorCopilot`)
- **Tracking issues:**
  - [armoriq/armorCopilot#1](https://github.com/armoriq/armorCopilot/issues/1) — parent
  - [armoriq/conmap-auto#247](https://github.com/armoriq/conmap-auto/issues/247) — backend `/copilot-studio/*` endpoints
  - [armoriq/armorCodex#18](https://github.com/armoriq/armorCodex/issues/18) — shared core library extraction (deferred)
- **Plan doc:** [/Users/hariharasudhan/Armoriq/ARMORCOPILOT_PLAN.md](/Users/hariharasudhan/Armoriq/ARMORCOPILOT_PLAN.md)
- **Brief doc for Hui (CEO):** [/Users/hariharasudhan/Armoriq/MEETING_BRIEF_HUI_2026-05-21.md](/Users/hariharasudhan/Armoriq/MEETING_BRIEF_HUI_2026-05-21.md)

### Phase A.8 — PoC + architectural pivot — DONE 2026-05-22

Originally PoC'd inside `conmap-auto` (4 commits on `feat/copilot-studio-webhook-poc`), then reverted after Hari flagged that calling the backend directly didn't match the ArmorClaude/ArmorCodex pattern. Pivoted to the right shape: standalone service in this repo + SDK integration helper.

#### Final architecture (matches ArmorClaude/ArmorCodex)

```
Microsoft Copilot Studio
  → HTTPS POST /analyze-tool-execution/:tenantId
@armoriq/armorcopilot-ms (this repo, Cloud Run deploy)
  - verifyCopilotStudioSignature() from @armoriq/sdk      ← HMAC via SDK helper
  - translateCopilotStudioPayload() from @armoriq/sdk
  - axios → POST /iap/sdk/enforce on ArmorIQ backend       ← single backend call
ArmorIQ backend (conmap-auto, unchanged)
  → returns {allowed, action, reason}
  ← back to MS as {action: allow|block}
```

#### What's where now

| Repo / branch | What landed |
|---|---|
| `armoriq/armorCopilot` (this repo) — `feat/armorcopilot-ms-skeleton` | `packages/armorcopilot-ms/` Express service (5 source files + Dockerfile + README + .env.example) |
| `armoriq/armoriq-sdk-customer-ts` — `feat/microsoft-copilot-integration` (off `dev`) | New `src/integrations/microsoft_copilot.ts` (HMAC verify + payload translator + decision mapper) + index exports + version bump 0.3.3 → 0.4.0 |
| `armoriq/conmap-auto` — `feat/copilot-studio-webhook-poc` | Reset to ONLY commit `361d90b` (lint-staged setup for husky — useful repo improvement). All previous webhook/tenant/migration code reverted. Staging DB rolled back (`copilot_studio_tenants` table dropped). |

#### Files in `armorCopilot/packages/armorcopilot-ms/`

```
package.json                  Express + @armoriq/sdk + axios deps. Targets @armoriq/sdk@^0.4.0 (must be published first)
tsconfig.json                 ES2022, CommonJS, strict
Dockerfile                    Two-stage Node 20 alpine build for Cloud Run
.env.example                  ARMORIQ_API_KEY, ARMORIQ_BACKEND_ENDPOINT, COPILOT_STUDIO_DEFAULT_SECRET, COPILOT_STUDIO_TENANT_<id>_SECRET
README.md                     Architecture notes + local dev + Cloud Run deploy steps
src/
├── index.ts                  Express bootstrap. GET /health, POST /analyze-tool-execution/:tenantId
└── enforce.ts                Thin axios wrapper around /iap/sdk/enforce. TODO: replace with SDK's client.enforceOnce() once the SDK exposes plan-less enforce
```

#### SDK additions (`armoriq-sdk-customer-ts/src/integrations/microsoft_copilot.ts`)

- `verifyCopilotStudioSignature({ rawBody, signature, timestamp, secret })` — pure crypto HMAC verify with 5min skew tolerance, constant-time compare
- `translateCopilotStudioPayload(payload)` — MS shape → `{ toolName, args, ...meta }`
- `toCopilotStudioDecision(enforceResult)` — wraps SDK enforce result into MS-shaped `{ action, reason? }`
- All exported from `@armoriq/sdk` top-level

#### Pending — design discussion (Week 3 priority)

The SDK's `session.enforce()` requires a registered plan via `startPlan()`. Copilot Studio's per-tool-call interception doesn't have an upfront plan concept. For now, `packages/armorcopilot-ms/src/enforce.ts` makes a manual axios call to `/iap/sdk/enforce` with a synthetic intent token. Proper fix: add `client.enforceOnce(tool, args)` to the SDK so armorcopilot-ms can drop the manual axios call.

Filed in armorCopilot tracker. Don't ship MVP without this.

Modified: `enterprise/conmap-auto/src/app.module.ts` (registered `CopilotStudioModule`)

#### Schema changes

`prisma/schema.prisma` — added:
- `CopilotStudioTenant` model: id, orgId, name, hmacSecret, status, lastSeenAt, createdAt, updatedAt; unique (orgId, name); Organization relation
- `CopilotStudioTenantStatus` enum: `active`, `disabled`
- Relation in `Organization` model: `copilotStudioTenants CopilotStudioTenant[]`

Migration: `prisma/migrations/20260522_add_copilot_studio_tenants/migration.sql` — committed to git. Applied to staging DB out-of-band via `prisma db execute` + manual `_prisma_migrations` row (because the existing migrations history has unrelated drift that blocks `migrate dev` locally).

#### Verification status

`tsc --noEmit` clean on both repos. End-to-end live testing pending:
1. Publish `@armoriq/sdk@0.4.0` (or use local file: link)
2. `npm install && npm run dev` in `packages/armorcopilot-ms/`
3. Smoke test: signed POST → 200 `{"action":"allow"}` (existing API key + COPILOT_STUDIO_DEFAULT_SECRET set in `.env`)
4. Production deploy: `gcloud run deploy armorcopilot-ms` (see README)

#### Pending finish (housekeeping)

1. Open 3 PRs (conmap-auto lint-staged, sdk microsoft_copilot integration, armorCopilot package)
2. Publish SDK 0.4.0 (or 0.4.0-dev) to npm so `armorcopilot-ms` can resolve via semver
3. Add `client.enforceOnce()` to SDK (Week 3 priority — replaces the manual axios wrap in `src/enforce.ts`)

---

## 5. What's next (week-by-week)

### Week 1 (DONE 2026-05-21)
- [x] Phase 0: repo + tracking issues
- [x] Phase A.8: backend PoC stub
- [x] PoC validation: signed POST returns `{"action":"allow"}` in 7.7ms
- [x] Commit PoC (commit 9503cee)
- [ ] Open draft PR against `dev` referencing #247
- [ ] Register PoC URL in a test Copilot Studio tenant (Hari needs Microsoft side access)

### Week 2 — Tenant onboarding (DONE 2026-05-22, ahead of schedule)
- [x] DB schema: `copilot_studio_tenants` table + `CopilotStudioTenantStatus` enum
- [x] Prisma migration (applied via `prisma db execute` due to unrelated migration drift)
- [x] `POST /copilot-studio/tenants` endpoint (JwtAuthGuard) — registers + returns webhook URL + HMAC secret
- [x] `GET /copilot-studio/tenants` admin list endpoint
- [x] `DELETE /copilot-studio/tenants/:tenantId` soft revoke
- [x] Wire `HmacAuthGuard.resolveTenantSecret()` to DB (with env fallback for dev)
- [ ] Frontend page on `platform.armoriq.ai/products/armor-copilot` for tenant registration
  - Reuse existing armorClaude / armorCodex product page patterns (see `armorIQ-Frontend`)
  - Tracking: not started — separate frontend PR

### Week 3 — MVP (Phase A.9)
- [ ] Replace stub `decision.service.ts` with real `IapPolicyDecisionService.evaluate()` call
  - Map MS payload → `IapEnforceRequest` shape (see `enterprise/conmap-auto/src/iap/dto/*`)
  - Resolve org/agent from `tenantId` + `agentMetadata`
- [ ] Audit pipeline: call `enqueueAudit(dto)` after every decision
- [ ] Latency budget: instrument p95, target <400ms (Microsoft's cap is 1000ms)
- [ ] Load test: k6 script against `/copilot-studio/analyze-tool-execution/:tenantId`
- [ ] Admin dashboard surface: filter audit feed by `productKind: "armor-copilot"`
- [ ] Update plan + tracking issue with results

### Week 4 — First customer onboarding
- [ ] Pick a friendly customer running Copilot Studio agents
- [ ] Walk them through: generate webhook URL, paste into Copilot Studio admin, confirm health check passes
- [ ] Run a test deny rule, confirm block + reason string in Copilot Studio UI

### Phase B — ArmorCopilot-GH (sequenced AFTER MS MVP)
**Do not start until Phase A.9 is done.** Estimated effort: ~1 week.

- [ ] File tracking issue: `armoriq/armorCopilot: tracking: ArmorCopilot-GH (gh copilot CLI hooks port)`
- [ ] Port armorCodex `scripts/lib/*` → `packages/armorcopilot-gh/scripts/lib/*` (see file-by-file map in [ARMORCOPILOT_PLAN.md](/Users/hariharasudhan/Armoriq/ARMORCOPILOT_PLAN.md) section B.1)
- [ ] Adapt hook payload parsing: Codex shape → GH Copilot CLI shape
- [ ] Write `install_armorcopilot_gh.sh`
- [ ] Submit to community list (if it exists) + document install on armoriq.ai

---

## 6. Reference: cross-product reuse

When implementing ArmorCopilot, lean heavily on what's already shipped:

### From `conmap-auto` (for backend logic)
- `enterprise/conmap-auto/src/iap/iap-policy-decision.service.ts` — full policy engine, agent scoping, OPA eval
- `enterprise/conmap-auto/src/iap/iap-sdk.service.ts` — pattern for HTTP-driven enforcement (closest analog to our webhook)
- `enterprise/conmap-auto/src/iap/iap.controller.ts` — controller pattern + auth guards
- `enterprise/conmap-auto/src/iap/dto/*.ts` — DTO patterns
- `enterprise/conmap-auto/CLAUDE.md` — IAP/delegation/SDK consumer reference + gotchas

### From `armorCodex` (for ArmorCopilot-GH, Phase B only)
- `armorCodex/plugins/armorcodex/scripts/lib/*.mjs` — ~85% portable. See port table in [ARMORCOPILOT_PLAN.md](/Users/hariharasudhan/Armoriq/ARMORCOPILOT_PLAN.md) section B.1.
- `armorCodex/install_armorcodex.sh` — template for `install_armorcopilot_gh.sh`
- `armorCodex/test-local.sh` — local-stack verification harness

### From `armorClaude` (for ArmorCopilot-GH, reference only)
- `armorClaude/scripts/lib/audit-wal.mjs` — original async WAL pattern (already ported to armorCodex)
- `armorClaude/scripts/lib/daemon.mjs` — separate-process daemon (we use embedded flusher instead for Codex; same pattern likely for GH)

---

## 7. Key reference docs

- **Plan doc (full):** [/Users/hariharasudhan/Armoriq/ARMORCOPILOT_PLAN.md](/Users/hariharasudhan/Armoriq/ARMORCOPILOT_PLAN.md)
- **CEO brief:** [/Users/hariharasudhan/Armoriq/MEETING_BRIEF_HUI_2026-05-21.md](/Users/hariharasudhan/Armoriq/MEETING_BRIEF_HUI_2026-05-21.md)
- **Project CLAUDE.md (root):** [/Users/hariharasudhan/Armoriq/CLAUDE.md](/Users/hariharasudhan/Armoriq/CLAUDE.md)
- **conmap-auto CLAUDE.md:** [/Users/hariharasudhan/Armoriq/enterprise/conmap-auto/CLAUDE.md](/Users/hariharasudhan/Armoriq/enterprise/conmap-auto/CLAUDE.md)
- **Microsoft Copilot Studio external security webhooks docs:** https://learn.microsoft.com/en-us/microsoft-copilot-studio/external-security-webhooks-interface-developers
- **GitHub Copilot CLI hooks reference (for Phase B):** https://docs.github.com/en/copilot/reference/hooks-configuration

---

## 8. Conventions + project rules

These come from [/Users/hariharasudhan/Armoriq/CLAUDE.md](/Users/hariharasudhan/Armoriq/CLAUDE.md). Critical ones:

- **Issue-first hard rule:** open a tracking issue BEFORE starting work — even info-only tracking issues
- **No em-dashes in user-facing copy** (use plain hyphens or restructure) — applies to docs, UI strings, blog posts
- **Use proper Prisma migrations** (`npx prisma migrate dev`) — never `npx prisma db push`
- **Reuse existing components and code** — don't create new ones if existing can be used
- **Don't generate comments** unless absolutely necessary
- **No emojis in code or comments**
- **Use `conda activate meta` if needed** for Python tasks
- **Always delete debug or temp scripts** when done

### ArmorCopilot-specific conventions

- Brand the product as **ArmorCopilot** in UI / docs (exact casing)
- Backend logs / decision service use `[copilot-studio]` prefix
- Each tenant has unique webhook URL: `/copilot-studio/analyze-tool-execution/<tenantId>`
- HMAC headers: `X-ArmorCopilot-Signature` (sha256 hex) + `X-ArmorCopilot-Timestamp` (unix seconds)
- 5min timestamp drift tolerance
- Decision response shape (Microsoft-defined): `{ action: "block" | "allow", reason?: string }`

---

## 9. How to resume work in a new session

1. Open this file (`/Users/hariharasudhan/Armoriq/armorCopilot/SESSION_CONTEXT.md`)
2. Read it top to bottom (this section included)
3. Verify current state matches:
   ```bash
   # Confirm PoC stub still exists
   ls /Users/hariharasudhan/Armoriq/enterprise/conmap-auto/src/copilot-studio/

   # Check branch state in conmap-auto
   git -C /Users/hariharasudhan/Armoriq/enterprise/conmap-auto branch --show-current
   # Expect: feat/copilot-studio-webhook-poc

   # Confirm health endpoint live (only if conmap-auto running)
   curl http://localhost:3000/copilot-studio/health
   ```
4. Pick up at "What's next" section above based on what's still pending
5. If anything's changed since this doc was written, update this doc as you go

---

## 10. Open questions (for Hari to answer / ask)

- [ ] Does Hari have access to a Microsoft Copilot Studio test tenant for PoC URL registration?
- [ ] Should ArmorCopilot-MS launch with a free tier or behind paid plan? (talk to Hui)
- [ ] Do we want to file an issue on `microsoft/vscode` for the proposed permission API to push it toward GA?
- [ ] Frontend page: reuse the existing product page pattern from armorClaude/armorCodex or design a new one for tenant URL/secret display? (Stitch MCP if new design needed)

---

## 11. Decision log (additions go here as new sessions happen)

| Date | Session | Decision | Why |
|---|---|---|---|
| 2026-05-21 | Initial | Target MS Copilot Studio (not M365), sequence GH after MVP | See section 3 |
| 2026-05-21 | Initial | Host webhook in conmap-auto (not standalone service) | Reuses IapPolicyDecisionService + audit + auth infra; existing `/iap/sdk/enforce` already meets <1s budget |
| 2026-05-21 | Initial | Multi-tenant via path param `/analyze-tool-execution/:tenantId` | Each customer gets unique URL + HMAC secret |
| 2026-05-21 | Initial | Plain HMAC secret in DB (not KMS-encrypted) for v1 | PoC + MVP scope; documented as future hardening — secret cannot be hashed since we need it raw for HMAC verify |
| 2026-05-22 | Week 2 | lint-staged for husky pre-commit (vs whole-repo lint) | Repo has 3177 pre-existing lint errors that block every local commit; lint-staged scopes hook to staged files. Repo-wide cleanup tracked separately |
| 2026-05-22 | Week 2 | Applied migration via `prisma db execute` instead of `migrate dev` | Existing migrations history has unrelated drift (CREATE INDEX CONCURRENTLY can't run in shadow DB transaction); `migrate dev` rejects all new migrations until drift resolved |
| 2026-05-22 | Week 2 review | Dropped tenant CRUD endpoints; kept tenant table | User flagged that Week 2 was over-built relative to ArmorClaude/Codex (which use only the existing SDK). The TABLE has to stay — MS uses HMAC shared secrets per integration and the existing api_keys table stores only hashes. The CRUD endpoints (register/list/revoke) were unnecessary for MVP; can be re-added as a single one-shot endpoint or CLI when first customer needs onboarding UX |
| 2026-05-22 | Week 2 review | Keep webhook in conmap-auto (not standalone in armorCopilot repo) | Two-hop architecture (standalone webhook → SDK → conmap-auto) doubles network latency and threatens MS's 1000ms cap. ArmorClaude/Codex are local plugins so location was free; ArmorCopilot is server-to-server with hard deadline |

---

*End of SESSION_CONTEXT.md. If you've read this far in a new session, you're ready to pick up where the last session left off.*
