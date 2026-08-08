## What and why

<!-- What changes, and the reason. The diff shows the what; explain the why. -->

## Behavior change

<!-- Anything a user would notice: flags, env vars, response shapes, defaults.
     Write "none" if purely internal. -->

## Checklist

- [ ] `pnpm check` passes (typecheck + lint + test)
- [ ] Tests cover the change
- [ ] `--help` and README updated if flags or env vars changed
- [ ] No new `process.env` reads outside `config/env.ts`
- [ ] No new module-level mutable state
