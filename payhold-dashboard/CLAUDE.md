# payhold-dashboard

React + Vite + Tailwind 4 on Cloudflare Pages. The product's face for client
companies, and a pure client of the PayHold public API — **no secrets, no
direct database access, ever**.

See `../CLAUDE.md` for the product rules that bind both repos (the escrow
wording ban, the money invariants, the API contract).

## Current state: mock backend

There is no backend yet. `src/api/mock/` implements the entire v1 contract as a
real state machine in the browser, persisted to localStorage.

```
npm run dev        # http://localhost:5173
npm test           # engine invariant tests
npm run typecheck
npm run build
```

The floating **Simulate** button (dev only) is the control panel: fund a deal,
advance the clock, run cron, force a payout failure, inject ledger drift, switch
tenant, reset fixtures. Everything a provider webhook or cron job would do.

## The seam

```
src/api/
├── types.ts     the v1 domain types — copy verbatim into payhold-backend
├── client.ts    PayHoldClient interface — what every screen codes against
├── index.ts     exports `api`; ONE line changes when the backend lands
└── mock/        store (localStorage + simulated clock), seed, engine, client
```

Screens import `api` from `@/api` and nothing else. When `HttpClient` exists,
`src/api/index.ts` picks it based on an env flag and no screen changes.

`SimulationApi` (the `sim` property) exists only on the mock. Guard any use of
it with `isSimulated(api)` so it compiles away against the real client.

## Engine tests are the backend's spec

`src/api/mock/engine.test.ts` encodes the invariants: release needs both
confirmations, no double release, refund blocked after release, timer fires only
on non-disputed deals, payouts blocked while frozen, deposits capped at the
pre-auth, balances derived purely from ledger entries. **Reproduce every one of
these against the real Edge Functions.** If a rule changes, change it here first.

## Conventions

- **Money is integer minor units everywhere.** Only `lib/format.ts` divides by
  100. Forms take major units and convert at the boundary.
- Colors come from the semantic tokens in `index.css` (`bg-surface`, `text-fg`,
  `bg-held-soft`…). No raw Tailwind palette colors in screens.
- Status vocabulary lives in `DEAL_STATUS_META` / `PAYOUT_STATUS_META`. Labels
  and plain-language hints are defined once, never inline.
- Money mutations use `useMoneyMutation` / `useMoneyAction`, which invalidate
  every query — a release touches the deal, ledger, balance, payouts and audit
  at once.
- Public pages (`src/screens/public/`) are seen by buyers and sellers. Plain
  language, no jargon, no status codes.
