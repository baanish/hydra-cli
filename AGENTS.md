# AGENTS.md

## Cursor Cloud specific instructions

### Overview

hydra-cli is a self-contained TypeScript CLI built on the **Bun** runtime. It runs multi-agent research queries via LLM calls and produces consolidated synthesis briefs. There is no Docker, no external databases, and no monorepo structure.

### Runtime

- **Bun >= 1.1.0** is required (not Node.js). The project uses `bun:sqlite`, `Bun.serve()`, and `bun link`.
- Bun is installed to `~/.bun/bin/bun`. Ensure `~/.bun/bin` is on `$PATH` (e.g. `export PATH="$HOME/.bun/bin:$PATH"`).

### Key commands

All scripts are defined in `package.json`:

| Task | Command |
|------|---------|
| Install deps | `bun install` |
| Lint | `bun run lint` |
| Typecheck | `bun run typecheck` |
| Test | `bun test` |
| Build | `bun run build` |
| Run CLI | `bun run src/index.ts --help` |
| Link globally | `bun link` (then use `hydra` command) |
| Web UI | `bun run src/index.ts web --port 3737` |

### Known test issue

When running `bun test` (all test files together), 7 tests in `personas.test.ts` and `pipeline.test.ts` fail due to Bun's `mock.module` leak from `personas.error.test.ts` (which mocks `writeFileSync` to throw). All tests pass when run in isolation (e.g. `bun test src/engine/personas.test.ts`). This is a pre-existing Bun mock isolation issue, not a code bug.

### API key

The CLI requires a `HYDRA_SYNTHETIC_API_KEY` environment variable (or manual `hydra config set synthetic-api-key <key>`) to make LLM/search calls. Without it, `hydra run` will fail. Config is stored in `~/.config/hydra-cli/config.json`.

### Lint notes

`bun run lint` (biome check) reports pre-existing formatting/style diagnostics (tabs vs spaces, import ordering) and exits non-zero. This is the repository's current state and does not indicate a setup problem.
