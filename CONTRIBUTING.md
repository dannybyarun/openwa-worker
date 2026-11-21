# Contributing

Issues and pull requests are welcome. Keep changes small and explain the behaviour they change.

## Setup

```bash
npm ci            # required: postinstall patches baileys for workerd
npm run dev       # builds the UI, then Miniflare on http://localhost:8787
```

For UI work, run the worker and Vite separately so the page hot-reloads:

```bash
npm run build
npm run dev:worker   # :8787
npm run dev:ui       # :5173, proxies /api and /health
```

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
```

All three must pass. `npm run typecheck` checks the worker and the UI. CI runs the same three on
every pull request, so you can see a failure without anyone reviewing it first.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through
[SECURITY.md](SECURITY.md), not a public issue or PR.

## Ground rules

- **Do not add a reconnect loop or a recurring alarm.** The lazy lifecycle (`/wake` → `/messages` →
  `/ack` → `/idle`) is the product. An always-on Durable Object exhausts the free plan; see
  `docs/architecture.md`.
- **Do not bypass the baileys patch guards.** They fail loudly when the pinned dist changes, which
  is intentional. Bumping baileys means updating both patches and their specs.
- **New cursor logic goes in `src/messages.ts`**, which is Durable-Object-free and unit-tested. Do
  not duplicate it inside `session-do.ts`.
- **New env vars** go in `wrangler.toml` *and* `src/env.ts`, then `npm run types`. Never hand-edit
  `worker-configuration.d.ts`.
- **UI changes** should stay dependency-light. React, Tailwind, TanStack Query, Radix dialogs, and
  `qrcode` are the current set; justify anything new.
- Keep the API and the Apps Script drainer in sync (`apps-script/Code.gs`).

## Commit messages

Short imperative subject, a body that explains why when it is not obvious. Reference an issue when
one exists.
