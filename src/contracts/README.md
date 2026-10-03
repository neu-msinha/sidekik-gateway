# TEMPORARY: stand-in for `@sidekik/contracts`

`sidekik-platform` hasn't published `@sidekik/contracts` yet. These files implement the subset the gateway needs, written straight from `docs/ARCHITECTURE.md` §5 and the API in `sidekik-platform/docs/DESIGN.md` §3–4. The file names match the platform layout.

**Every other file in this repo imports contracts only from `src/contracts/index.ts`.** When `v0.1.0` is tagged:

1. `pnpm add github:<org>/sidekik-platform#v0.1.0`
2. Replace `index.ts` with `export * from '@sidekik/contracts';` and delete the other files here.
3. Run `pnpm typecheck && pnpm test` and fix any name drift.

Assumptions to confirm with Sahil, because perception and the other consumers have to match:

- `sk_token`: HS256 JWT with claims `{sid, org, role, kind}`, `exp` 2 h after `iat`, no `iss`/`aud`.
- Bus entries: `XADD <stream> MAXLEN ~ 10000 * data <JSON envelope>` (one field named `data`).
- Envelope `type` values: `"session.lifecycle"`, `"transcript.turn"`, `"speech.signal"`, `"dom.event"`.
