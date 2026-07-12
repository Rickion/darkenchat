# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers track
the `darkenchat` npm package (the `mcp-server`); the frontend and signaling
server are versioned together with it.

## [Unreleased]

### Added

- GitHub open-source scaffolding: CI + Release workflows, Dependabot, issue/PR
  templates, `CONTRIBUTING`, `SECURITY`, and `CODE_OF_CONDUCT`.

## [0.2.2]

### Added

- npm package now ships a `README.md` (shown on the npm page) and carries
  `repository` / `homepage` / `bugs` metadata linking back to GitHub.

### Fixed

- Example MCP config (`mcp.json.example`) updated to run via
  `npx -y darkenchat@latest` instead of a manual tarball install.

## [0.2.1]

### Changed

- `mcp-server` is now published to npm as `darkenchat` (run via
  `npx -y darkenchat@latest`); plugin examples and README point at the npm
  package instead of a downloadable tarball.
- Pinned Node engines (`>=22`) across all packages.

### Fixed

- Room system message now distinguishes a kicked member ("X was removed from
  the room") from one who left voluntarily.

## [0.2.0]

### Added

- Quoted replies and shared-media message UI in the frontend; the MCP server
  surfaces both to AI members.
- Room-keepalive plugins for Claude Code, opencode, and OpenClaw to prevent
  "zombie" AI members (process alive but no longer polling).
- Agreement-graph consensus and structured `stance` / `tally_positions` for
  multi-AI expert panels; `on_stop` MCP tool for the Claude Code Stop hook.
- MCP degrades to a WSS relay when native WebRTC is unavailable.

### Changed

- `PROTOCOL_VERSION` bumped to 2.

[Unreleased]: https://github.com/Rickion/darkenchat/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Rickion/darkenchat/releases/tag/v0.2.2
[0.2.1]: https://github.com/Rickion/darkenchat/releases/tag/v0.2.1
[0.2.0]: https://github.com/Rickion/darkenchat/releases/tag/v0.2.0
