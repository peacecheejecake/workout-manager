# Workout Manager repository guide

Applies to the entire repository. Nested `AGENTS.md` files supplement these rules for their subtree.
Follow user instructions first, then the nearest applicable repository guidance.

## Communication and source of truth

- Respond in Korean by default. Write repository agent instructions in English; preserve canonical code/schema names.
- Read `docs/implementation/README.md` for execution order and `docs/.pre/README.md` for the design baseline.
- Product scope is S01–S35 in `docs/.pre/01_product_screen_spec.md`. Requirements and acceptance IDs live in
  `05_implementation_requirements.md`; unfinished work lives in `06_follow_up_backlog.md`.
- Use `02_frontend_architecture.md`, `03_design_system.md`, `07_responsive_layout.md`, and the v0.2.2/v0.2.3
  extensions when changing related code. Draft TypeScript contracts are not implemented runtime validation.
- Preserve historical prototype/QA evidence. Record new verification separately; never turn `not_executed` into
  passed based on a typecheck, mock, or documentation review.
- This repository currently contains Python FIT utilities and design artifacts. The JS workspace, apps, tests,
  and commands below are planned M0 deliverables, not existing capabilities. Verify availability before use.

## Product invariants

- Keep planned, proposed, draft, and actual data distinct. Only explicit user approval applies a plan proposal.
  A drag, timer completion, sync event, or successful LLM response is not approval or proof of actual performance.
- Preserve EvidenceSnapshot → Decision → Proposal → PlanVersion. Validate freshness and the complete dependency
  manifest on approval, including absent aggregate heads, actual revisions, consent, and policy changes.
- Apply all affected training/nutrition/recovery/routine schedule writes, approval history, and outbox atomically.
  Use stable idempotency keys; a repeated successful approval returns the original result without a new version.
- Keep source, canonical activity, user overlay, revisions, and deletion suppression separate. Do not double-count
  the same activity across providers, supplementary detail, routine runs, or parent/child bouts.
- Nutrition actuals belong to IntakeEntry; exercise actuals to Activity and its details; non-exercise recovery to
  RecoveryActionLog. RoutineRun links actuals and never creates an extra synthetic activity.
- Distinguish unknown/null, zero, partial, confirmed skipped, and stopped. Preserve units, measurement definitions,
  provenance, local dates/timezones, and versioned calculation definitions.
- Preserve frozen blueprint/content versions for approved schedules and started runs. Expand recurrence only over
  bounded periods/counts. Unresolved anchors remain unresolved; never fabricate missing timing or provider fields.
- Separate reviewed content, user reports, device observations, and AI estimates. Feature tests do not establish
  physiological validity, injury prediction, or recovery efficacy.

## Architecture boundaries

- `apps/web`: thin Next.js routes, auth boundary, navigation, layout, Host adapter, and initial composition.
- `apps/mobile-web` / `apps/mobile`: Vite React shell / Capacitor and native capabilities; reused domain modules.
- `apps/api`: Fastify `/bff/v1` and application API boundary. Same-origin proxy routes browser requests here.
- `apps/worker`: ingestion, FIT, media, indexing, coaching jobs; durable outbox and idempotent consumers.
- `packages/modules/*`: domain screens/use cases. No other module's private imports or direct Next.js imports.
- `packages/experience/*` and `packages/ui/*`: controlled interactions, primitives, semantic tokens, accessibility.
  They do not fetch providers, own domain policy, or approve plans.
- `packages/contracts`, `api-client`, `platform`: runtime DTO schemas, API/cache conventions, Host/transport contracts.
- `packages/server/*`: domain, application services, persistence/integration adapters, metrics/evidence/retrieval.
  Pure domain code depends on neither HTTP, React, nor database frameworks; inject I/O and clocks through ports.
- Preserve dependency direction: apps → modules → kits/UI/platform/api-client/contracts. Enforce package exports and
  lint boundaries. Public subpath exports are allowed; giant barrel files and private deep imports are not.
- Never duplicate Fastify business endpoints in Next route handlers. Never expose ORM entities, credentials, or
  server-only dependencies through shared browser contracts.

## TypeScript and contracts

- Use strict TypeScript, explicit public contracts, discriminated unions, and exhaustive state handling. Validate
  `unknown` at API, storage, provider, environment, and bridge boundaries. Avoid `any` and unchecked assertions.
- Keep types inferred from runtime schemas where practical. Change schemas, producers, consumers, migrations,
  fixtures, and relevant tests together. Preserve explicit version compatibility and unit semantics.
- Prefer small cohesive functions, named exports, early returns, immutable updates, and descriptive domain names.
  Respect framework-required default exports. Follow the package's selected module resolution convention.
- Inject clocks/IDs/randomness where determinism matters. Define stable sorting/tie-breaks and timezone behavior.
- Preserve user changes and staged files. Do not commit generated build/cache/coverage/test output or personal data.

## React, Next.js, and Zustand practices

- Use the exact Vercel upstream React Best Practices skill as the frontend baseline:
  https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices
  Read its `SKILL.md` and relevant rules before React implementation/review. Record the upstream revision when
  registering/installing it in M0; do not substitute an unrelated skill with the same short name.
- Prioritize independent fetch concurrency, bundle boundaries, and measured rendering costs. Apply rules within
  this architecture: TanStack Query handles server cache; Next-specific APIs stay in the shell.
- Use Server Components for suitable shell composition and small client boundaries. Keep reusable modules usable
  without Next/RSC; pass serializable initial data and Host capabilities. Lazy-load maps, editors, charts, and media.
- Follow Rules of Hooks and exhaustive dependencies. Derive values instead of synchronizing duplicate state through
  effects. Clean up subscriptions/timers/requests. Use stable keys and profile before adding memoization.
- Zustand owns shared client drafts, workspace interactions, runner UI, and preferences. Use store factories scoped
  to user/workspace/provider lifetimes, narrow selectors, explicit actions, and immutable updates.
- Never use a mutable module singleton across SSR requests. Align server/client initial state; define hydration
  and persisted-state migration explicitly. Server Components do not read/write client stores.
- TanStack Query owns server response caching. Do not copy full responses into Zustand as a second source of truth.
  Scope query keys by authenticated user and resource/query context; cancel/invalidate after mutations appropriately.
- URL state owns shareable period/view/filter/sort/selection. Local React state/ref remains appropriate for isolated
  controls. Keep renderer-independent drafts and timers above responsive layout switches.
- Persist only allowlisted preferences by default. Health drafts need explicit consent, user scope, expiry/deletion
  policy, and pending-sync UI. Clear private cache/store/blob URLs on logout/account switch. Never persist tokens.
- Show approval success only after the server commits. Preserve drafts and present stale/conflict/offline states.

## CSS, UI, and accessibility

- Use semantic tokens from the design system and CSS Modules for component styles. Use typed finite variants,
  CSS custom properties for runtime values, and native/ARIA/data attributes for DOM state.
- Generate responsive constants/fixtures from `docs/.pre/responsive-spec.json`: viewport thresholds 768/1280,
  module container adaptation separately. Do not scatter hand-maintained breakpoint copies across packages.
- Prefer semantic elements, labelled controls, keyboard navigation, visible focus, reduced motion, and non-drag
  alternatives. Essential actions cannot depend on hover. Preserve IME composition and focus across layout changes.
- Implement loading, empty, partial, error, stale, unavailable, and sync-pending states. Data gaps are not zeros.
- Timers use reference time and pause durations, recalculated on foreground. Tick callbacks are presentation only;
  timer completion cannot silently create an actual log. Avoid per-second screen-reader announcements.

## Fastify, persistence, and worker practices

- Keep routes in encapsulated plugins. Handlers validate and delegate to application services; inject clients and
  repositories, declare dependencies/decorators, and close resources through lifecycle hooks.
- Validate path/query/body and relevant headers; derive ownership from authentication, not client athlete IDs.
  Enforce tenant ownership/RLS, CSRF for cookie-authenticated writes, and bounded request/upload limits.
- Return stable status/error codes and sanitized messages. Await asynchronous boundary calls; avoid mixed callback
  and promise handler styles. Propagate cancellation, deadlines, and bounded retries.
- Use migrations and database constraints for invariants, transactions for multi-domain commands, and explicit
  concurrency control for version updates. Test real concurrent transactions, not just repository mocks.
- Never call LLMs/providers inside a DB transaction. Use transactional outbox, leases, deduplication, and replayable
  jobs; honor retry-after and distinguish permanent from transient failure.
- Treat downloaded URLs, redirects, uploads, retrieved text, and model/tool outputs as untrusted. Use allowlists,
  parser bounds, ACL-filtered retrieval, and validated tool contracts. Ingestion must not bypass deletion suppression.
- Keep logs structured and correlated. Redact tokens/cookies, raw health data, precise GPS, prompts, provider payloads,
  and signed URLs. Store bounded audit facts separately from operational logs.
- Apply resource deletion/consent withdrawal to raw data, derived data, indexes, cache, media, and citations. Do not
  resurrect deleted excerpts through retrieval or retries. Verify export, backup restore, and operational recovery.

## Python FIT utility practices

- Keep Python/uv independent from the JS app toolchain. Reuse `src/workout_manager` and existing script entry points
  for batch download/import/conversion; do not duplicate product domain/approval rules here.
- Use typed functions, pathlib, explicit CLI arguments, logging, bounded I/O, and a guarded entry point. Separate
  fetching, parsing, normalization, and writing so each can be tested without credentials or live providers.
- Match file contents to extensions: CSV via `to_csv`, Parquet via `to_parquet`. Current `scripts/fitparse.py` needs
  this correction when reused. Make overwrite/output-directory behavior explicit.
- Downloads need permitted sources, timeouts, URL/redirect validation, temporary-file atomic writes, hashes,
  resumable manifests, rate limits, and per-file failure reports. Do not invent an official Garmin download API.
- Use Ruff for lint/format and pytest with synthetic/de-identified FIT fixtures. Never commit personal FIT/GPS,
  download outputs, tokens, or credential-bearing manifests.

## Testing and real-browser verification

- M0 must configure Prettier, ESLint, typecheck, Vitest unit/component tests, real-DB integration tests, Playwright
  E2E, and CI. Until implemented, report unavailable commands honestly; do not silently treat skips as passes.
- Prefer behavior assertions: React Testing Library/user-event for UI, MSW for component boundary fixtures,
  Fastify inject for routes, isolated PostgreSQL for transactions/RLS, Playwright for complete user journeys.
- Test invalid input, missing/partial data, stale/duplicate/concurrent approvals, provider failures, tenant isolation,
  deletion, retries, deterministic ordering, hydration/reset, and state retention across responsive transitions.
- Playwright is the automated E2E runner from M0 regardless of the exploratory-browser choice. Keep tests isolated,
  use role/label locators and assertions rather than arbitrary sleeps, and capture failures without sensitive data.
- For changed UI flows, use the **Aside skill first**: read its `SKILL.md`, then `aside guide`; follow its installed
  instructions. For direct DOM/screenshots, also read `aside guide repl` before `aside repl`.
- If Aside is unavailable or cannot perform the check, record why and try **Chrome** with the available browser or
  computer-use skill/tool. If Chrome cannot be used, use **Playwright**. Record the tool actually used and limitations.
  Do not silently claim an Aside check based on a Playwright-only run.
- Check mobile/tablet/desktop, breakpoint boundaries, 320px reflow, narrow containers, keyboard/focus, touch alternatives,
  IME, and error recovery as relevant. Native HealthKit/WKWebView lifecycle requires separate real-device evidence.
- Documentation-only changes need link/consistency/diff checks, not fabricated app browser results.

## Peer review before every commit

- Follow the **Herdr skill**; obtain current instructions with `herdr --skill`. Confirm `HERDR_ENV=1` before any
  control command. Never inspect/control another focused Herdr session from outside a managed pane.
- Before committing, use an independent peer reviewer in a split pane in the current tab and repository. Preserve
  user focus with `--no-focus`; select right/down based on layout and skill guidance. Do not run bare `codex` as a
  subprocess in place of pane isolation. Do not use GitHub Connector review as an automatic fallback.
- Learn installed syntax with `herdr --help`, `herdr pane`, and `herdr agent`. Parse returned JSON IDs; do not guess
  pane identifiers. A typical sequence, subject to installed CLI syntax, is:

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
# Read .result.pane.pane_id from the response; use a unique reviewer name.
herdr agent start <reviewer-name> --kind codex --pane <returned-pane-id>
herdr agent prompt <reviewer-name> "Review the current task diff and relevant untracked files against requirements. Read only; do not edit or commit. Report actionable findings with file/line and validation gaps." --wait --timeout 60000
herdr agent read <reviewer-name> --source recent-unwrapped --lines 200
```

- Give the reviewer scope, design references, actual changed/untracked files, and validation results. Review must
  cover contracts, domain invariants, security/ownership, style/boundaries, regression risk, and tests.
- Wait for completed review and read its findings. A timeout, blocked/unknown state, startup success, or no visible
  output is not review completion. Use bounded waits and report progress; follow Herdr instructions for state/read.
- Address valid findings, verify fixes, and request re-review of materially changed code before committing. Assess
  every previous finding against current content; a reply or absence of a repeated finding is not fix evidence.
- Record reviewed diff identity (base HEAD and content hash or equivalent), outcome, fixes, and test evidence in the
  task/PR record. Changes after review require a relevant review refresh.
- If Herdr/peer review is unavailable, finish authorized edits/checks and report the specific blocker; leave the commit
  pending unless the user explicitly authorizes a different review workflow. Never claim self-review is peer review.

## Commits, PRs, and completion

- Use Conventional Commits (`type(scope): subject`). Use `docs` only for documentation-only changes.
- Commit/push only within user-authorized scope. Peer review is required before a commit; it is not authorization to
  create a commit. Preserve staged changes and keep unrelated files out of the task.
- PRs describe the concrete problem/result, changed boundaries, validation, and remaining limitations; follow an
  existing PR template. Link FUT/S/F/A IDs where applicable. Do not initiate external review mentions automatically.
- Run narrow checks during iteration and relevant broader checks before completion. Planned commands after M0:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:e2e
# When Python FIT code changes:
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

- Contract changes require validation and consumer typechecks; approval/persistence changes need transaction tests;
  UI changes need build and real-browser evidence. Update documentation and status with actual results.
- Distinguish implemented, mocked, verified, externally blocked, and not executed. Web MVP includes the specified
  official Garmin integration; native-inclusive release additionally requires M3. FIT fallback is not automatic sync.
