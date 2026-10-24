# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Zero-dependency Node.js CLI. The web UI is one static HTML file (inline CSS and JS) served by the tool's own local server on 127.0.0.1 under a strict CSP: no external fonts, scripts, images or CDNs.

## Users

Developers who use Claude Code: the maintainer and the teammates they share the tool with. They open the web UI once to add subscription accounts and API keys, then now and then to check what's in use, add a top-up key, or fix a sign-in.

## Product Purpose

claude-nonstop keeps a coding agent working through plan limits. Each Claude Code session starts on the first subscription account with usage left, then falls back to the person's own API keys, one by one, as each runs out. Success: setup in about two minutes, then never thinking about session or weekly limits again.

## Positioning

A relay with a fixed order: account 1 → account 2 → … → API key 1 → key 2 → …. API keys switch mid-request through a local gateway, so a running session never notices a key running out. Subscription sign-in always goes through Anthropic's own flow; the tool never holds subscription credentials.

## Operating Context

- CLI: `claude-nonstop` (or plain `claude` after setup) picks the account or key at launch.
- Local gateway on 127.0.0.1 serves the CLI and the Claude desktop app (via its Configure Third-Party Inference setting).
- Web UI opened with `claude-nonstop ui` through a one-time link; macOS, Windows and Linux.

## Capabilities and Constraints

- Accounts: add (opens Anthropic sign-in in the browser), sign in again, check usage, turn on/off, reorder, remove. The main account is the normal Claude Code login and can only be turned off.
- API keys: add (hidden input), test, rename, reorder, remove. States: works, used up (skipped for a cooldown), kept (problem not caused by the key), not checked.
- Secrets encrypted at rest; the encryption key lives in the OS credential store. Full keys are never shown again after saving.
- Desktop app setup: steps, base URL, gateway token, importable file.
- Settings: key cooldown minutes, account recheck minutes.

## Evidence on Hand

No screenshots, logos, testimonials or usage numbers exist. Do not invent any.

## Product Principles

1. The relay order is the product: always show what runs now and what runs next.
2. Problems surface first; healthy things stay quiet.
3. Secrets are handled visibly carefully: masked, never echoed, never sent anywhere but Anthropic.
4. Setup should take minutes and need no reading.
