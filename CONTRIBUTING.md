# Contributing to DarkenChat

Thanks for your interest in improving DarkenChat! Pull requests are welcome.
**Please open an issue first for significant changes** so we can discuss the
approach before you invest time.

## Project layout

This is a monorepo with three independent packages — there is **no root
`package.json`**. Install and build each package on its own:

```
frontend/    # Vite · Vue 3 · Vuetify · Pinia · Tiptap
signaling/   # Fastify · @fastify/websocket (Node 24 in prod, CI on 22)
mcp-server/  # @modelcontextprotocol/sdk · @roamhq/wrtc  (published to npm as `darkenchat`)
```

### Shared wire protocol

The WebRTC/signaling message types live in **`shared/protocol.ts`** — this is the
single source of truth. A prebuild/predev step (`shared/copy-into.mjs`) copies it
into each package's `src/_shared/` directory, which is **git-ignored and
regenerated on every build**. 

> Always edit `shared/protocol.ts`. Never edit a `src/_shared/` copy — your
> change will be wiped on the next build.

## Development setup

**Prerequisites:** Node 22+ (Node 24 recommended), and [coturn](https://github.com/coturn/coturn)
for local two-tab WebRTC. See the [Quick start](./README.md#quick-start-local-dev)
in the README for the full flow.

```bash
# per package
cd <package> && npm install && npm run dev
```

## Before you open a PR

Run these in **every package you touched**:

```bash
npm run lint
npm run build
```

Both must pass — CI runs the same checks on Node 22 for all three packages.
All packages are TypeScript with `strict` mode enabled.

Formatting is enforced with Prettier + ESLint. Run `npm run format` to auto-fix.

## Commit / PR guidelines

- Keep PRs focused; one logical change per PR is easier to review.
- Reference the issue you're addressing (`Closes #123`).
- Update the README or relevant docs when you change behavior or configuration.
- Add a note to [`CHANGELOG.md`](./CHANGELOG.md) under `## [Unreleased]`.

## Releasing (maintainers)

The `mcp-server` package is published to npm as `darkenchat`. To cut a release:

1. Bump `mcp-server/package.json` `version` and move the `CHANGELOG.md`
   `[Unreleased]` section under the new version.
2. Commit, then push a matching tag: `git tag vX.Y.Z && git push --tags`.
3. The `Release` workflow builds, publishes to npm (using the `NPM_TOKEN`
   repo secret), and creates a GitHub Release with the packed tarball.

## License

By contributing, you agree that your contributions will be licensed under the
project's [AGPL-3.0](./LICENSE) license.
