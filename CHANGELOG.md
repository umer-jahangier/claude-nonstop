# Changelog

Every release of claude-nonstop, newest first. Full notes, and the code at each version, are on the [releases page](https://github.com/umer-jahangier/claude-nonstop/releases). The installer and `claude-nonstop update` install the latest release; the npm package is [`@umer-jahangier/claude-nonstop`](https://www.npmjs.com/package/@umer-jahangier/claude-nonstop).

## [1.16.3](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.16.3) · 2026-11-20

- Updates install only releases signed with the claude-nonstop release key (Ed25519 over the version and SHA-256), with the version inside the tarball checked too.
- The local certificate authority is name-constrained to this computer's own names and addresses; `claude-nonstop setup` replaces an older one.

## [1.16.2](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.16.2) · 2026-11-19

- Published on npm as `@umer-jahangier/claude-nonstop`; npm update and uninstall hints name it.
- Tests pass again on Node 18 and on Windows in CI.
- Website guides, a changelog, and contributing and security policies.

## [1.16.1](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.16.1) · 2026-11-19

- Codex answers aren't cut off at 16K tokens, and tools with oneOf/anyOf schemas reach Claude.

## [1.16.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.16.0) · 2026-11-19

- One gateway for Claude and ChatGPT, answering Claude Code, Codex and Cursor.
- Setup points Codex at the gateway.
- Apps tab with Codex and OpenAI-tool setup, default models in Settings, fixed service picker.

## [1.15.5](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.15.5) · 2026-10-28

- A burst rate limit no longer sets an account aside as out of usage; clients retry instead of getting a billing error.

## [1.15.4](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.15.4) · 2026-10-27

- Keep every Claude.ai sign-in alive, paused and limited accounts included.

## [1.15.3](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.15.3) · 2026-10-27

- Renew expired Claude.ai sign-ins through Claude Code instead of passing the account over.

## [1.15.2](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.15.2) · 2026-10-26

- Point every Claude Code install at the local gateway.

## [1.15.1](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.15.1) · 2026-10-26

- A key request carries no Claude Code identity in its system prompt either.

## 1.15.0 · not released on its own (included in the next release)

- API keys are used and tested as plain API.

## 1.14.3 · not released on its own (included in the next release)

- A subscription sign-in takes only Claude Code's requests, so the gateway makes the desktop app's look like one.

## 1.14.2 · not released on its own (included in the next release)

- The desktop app's model list comes from your accounts too, or from a built-in list.

## 1.14.1 · not released on its own (included in the next release)

- A subscription account's requests carry the OAuth beta only.

## 1.14.0 · not released on its own (included in the next release)

- The desktop app walks your order too, and every request goes out as Claude CLI.

## [1.12.1](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.12.1) · 2026-10-25

- Usage on its own line, a key alert that says what Anthropic refuses, and status says where sessions start.

## [1.12.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.12.0) · 2026-10-25

- How much of each account's plan is used, on the page and in status; Anthropic's plugin marketplace stays in third-party mode.

## [1.11.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.11.0) · 2026-10-25

- Every request goes out as Claude Code, the desktop app's included, and switch alerts that don't nag.

## 1.10.0 · not released on its own (included in the next release)

- Switch alerts for the desktop app, on the page and as notifications.

## [1.9.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.9.0) · 2026-10-25

- Every request goes out as Claude Code, the desktop app's included, and the desktop app hears when to switch between your Claude.ai account and API keys.

## [1.8.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.8.0) · 2026-10-25

- In Automatic mode, sessions on API keys go back to an account above them once it has usage again.

## [1.7.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.7.0) · 2026-10-25

- The official connector directory in the desktop app, honest desktop status, priority order in Automatic, and key checks billed as Claude Code.

## [1.6.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.6.0) · 2026-10-25

- The desktop app keeps its browser, extensions, plugin marketplace and connectors in gateway mode.

## [1.5.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.5.0) · 2026-10-25

- One relay order mixing accounts and keys, and pause for any account or key.
- Don't force strict sandbox mode on the desktop app's Code sessions; Strict sandbox switch in Settings; fix status test.

## [1.4.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.4.0) · 2026-10-25

- Check every account and key on start, on opening the page, and as soon as one is added.

## [1.3.1](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.3.1) · 2026-10-24

- Find Claude Code again after it moves, and don't call accounts signed out when it can't run.

## [1.3.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.3.0) · 2026-10-24

- Sessions never stall at a limit, and chats come along.

## [1.2.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.2.0) · 2026-10-24

- HTTPS at claude.nonstop, automatic desktop app setup, appearance switch, constellation.

## [1.1.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.1.0) · 2026-10-24

- Apple-style web page at claude.nonstop, live globe, rope switching, self-update.

## 1.0.0

- First version: Claude Code on your accounts, then your API keys, one by one.
