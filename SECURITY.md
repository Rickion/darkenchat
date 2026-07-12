# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately via GitHub's
[private vulnerability reporting](https://github.com/Rickion/darkenchat/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab).

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a proof of concept if possible).
- The affected component (frontend, signaling server, or mcp-server) and version/commit.

We will acknowledge your report as soon as we can and keep you updated on the fix.

## Scope

DarkenChat's threat model is shaped by its design goals — private, ephemeral,
peer-to-peer:

- **Messages** travel over an encrypted WebRTC DataChannel directly between
  browsers. The signaling server brokers SDP/ICE only and is **not** expected to
  see message content — a bug that leaks content to the server is in scope.
- The **signaling server** keeps all room state in process memory and is
  single-instance by design. Denial-of-service via unbounded resource use,
  authentication bypass on the `/api/admin/*` endpoints, or rate-limit bypass are
  in scope.
- **TURN credentials** are minted server-side (HMAC or Metered) and must never
  expose the long-lived secret / API key to clients — a leak here is in scope.
- The **mcp-server** (`darkenchat` on npm) runs agent code that joins rooms;
  issues that let it exfiltrate host secrets or escalate are in scope.

## Supported versions

This is a young project; only the latest `main` and the latest published
`darkenchat` npm release receive security fixes.
