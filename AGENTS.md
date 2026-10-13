# Agent guidance

`pi-last-words` is a pi extension for optional, tool-free final-response presentation. The package name is `pi-last-words`; the model-facing tool is `present_final`.

## Commands

- `npm ci --ignore-scripts` installs the locked development dependencies.
- `npm run lint` checks formatting and lint rules without writing changes.
- `npm run check` runs strict TypeScript checking without a build.
- `npm test` runs isolated deterministic tests.
- `npm run test:tui` is an optional offline CLI/PTY check requiring an installed pi CLI and Python 3 on a Unix-like system.
- `npm pack --dry-run --ignore-scripts` inspects distribution contents.

## Invariants

- Keep the tool optional, model-only and exclusive in its assistant message. It must not accompany user-facing reply text or sibling tools.
- The executing agent supplies settled conclusions; the presenter must not investigate, operate tools or make new technical decisions.
- Read the effective persisted projection at execution time. Do not replace it with raw history, a stale request snapshot or arbitrary truncation.
- Preserve complete historical tool pairs and message provenance. Remove execution system instructions and callable tool declarations from the presentation request only.
- Use the selected session model and a separate provider session identity. Cleanup must not affect the main agent connection.
- Stream cumulative text, then save the complete body in the final tool result. Do not forge assistant history or ask the main model to repeat successful output.
- Only a complete, non-empty response may return `terminate: true`. Failure and cancellation retain honest incomplete-output labels.
- Report available provider usage once; do not invent unknown usage or turn cleanup failures into duplicate-producing retries.
- `presenter.md` is the runtime presentation prompt. Change it conservatively and never register it as a skill or prompt template.
- Preserve intentional multilingual and Unicode fixtures in tests; public prose and code comments use English.

## Packaging

The `files` whitelist must include `index.ts`, `context.ts`, `render.ts` and `presenter.md`. README, LICENSE and package metadata are part of the distribution. Tests, developer instructions and brand source assets are not runtime dependencies.

`docs/pi-badge.svg` is an unmodified upstream reference and is excluded from formatting/linting. Preserve its bytes; owned SVG assets include accessible titles.

Pi host packages and `typebox` remain optional peers with `*` ranges, not bundled runtime dependencies. Development versions stay locked. Do not add model-specific settings, a mandatory handoff step or a copy command without a new product decision.

See `docs/ARCHITECTURE.md` for the context and result contracts and `docs/BRANDING.md` for the approved assets.
