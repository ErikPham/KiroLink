# Contributing

Thanks for helping out. This guide covers the setup, the checks, and the
conventions that reviews will hold you to.

## Setup

```bash
pnpm install
pnpm check     # typecheck + lint + test
```

Node 18+ and pnpm (see the `packageManager` field for the pinned version).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm check` | Everything CI runs: typecheck, lint, tests |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | oxlint, warnings treated as errors |
| `pnpm lint:fix` | Auto-fix what oxlint can |
| `pnpm test` | Vitest, single run |
| `pnpm build` | tsup → `dist/` with declarations |
| `pnpm dev` | Build then run the CLI |

`pnpm check` must pass before you open a PR. CI runs the same steps on Node 18,
20, and 22 via `pnpm release:check`.

## Where things go

Read [ARCHITECTURE.md](./ARCHITECTURE.md) first — it explains the layering and
the extension points. The short version:

- Adding a client protocol? Write a `ProtocolAdapter`, don't touch the pump.
- Adding a config knob? Declare it in `KiroLinkConfig`, read it in
  `config/env.ts`, and nowhere else.
- Swapping the upstream? Implement `KiroClient`.

Two rules the review will check:

1. **`config/env.ts` is the only module that reads `process.env`.**
2. **No module-level mutable state.** Use a factory and instance state.

Both exist so two instances can coexist in one process and so tests do not share
hidden state.

## Tests

Every behavior change needs a test. Use the harnesses:

```ts
import { fakeClient, textEvents } from '../support/harness'
import { postJson, startServer } from '../support/server'

const live = await startServer({ client: fakeClient(textEvents('hi')) })
const { status, body } = await postJson(live.url, '/v1/messages', { /* ... */ })
```

- Build config with `testConfig()`, never from the ambient environment.
- Prefer a test through the real server over a unit test of an internal helper —
  the server path is what users actually hit.
- Name tests for the behavior, not the function (`'rejects a body above the
  limit with 413'`, not `'test readBody'`).

## Style

The linter handles formatting; these are the things it cannot check.

**Comments explain why, not what.** Well-named code already says what it does. A
comment earns its place when it records a constraint, an upstream quirk, a
non-obvious invariant, or a decision a future reader would otherwise undo. The
existing comments about Kiro's wire-shape quirks are the model to follow — that
knowledge is expensive to rediscover.

**Don't restate the signature.** No `/** Gets the port. */` above `getPort()`.

**Types at the boundary.** Validate untrusted input where it enters and return a
narrowed type. Don't cast an unvalidated body to a request type.

**Errors carry their own mapping.** Throw a `KiroLinkError` subclass with a
`status` and `apiErrorType`. Never dispatch on `error.message` text.

**Keep it small.** Prefer a new module over growing an existing one past its one
responsibility.

## Commits and PRs

- Conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `chore:`).
- Explain the *why* in the body; the diff shows the what.
- One logical change per PR.
- Note any behavior change users would notice, and update `--help` and the README
  if you change flags or environment variables.

## Reporting bugs

Include the KiroLink version, Node version, OS, the client you used (Claude
Code, Codex, curl), and the output with `--verbose`. Redact tokens — `--verbose`
logs request metadata but not credentials, though upstream error bodies can
contain identifiers.

For a security issue, please use GitHub's private vulnerability reporting rather
than a public issue.
