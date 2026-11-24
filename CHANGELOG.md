# Changelog

Every release of claude-nonstop, newest first. Full notes, and the code at each version, are on the [releases page](https://github.com/umer-jahangier/claude-nonstop/releases). The installer and `claude-nonstop update` install the latest release; the npm package is [`@umer-jahangier/claude-nonstop`](https://www.npmjs.com/package/@umer-jahangier/claude-nonstop).

## [1.23.2](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.23.2) · 2026-11-25

- **Windows: no more Git windows.** Bringing cloud sessions here ran `git` (and `codex`) from the background gateway without hiding them, so every clone, fetch and check opened a console window, and Git's credential manager could pop up a sign-in window for a private repository. They now run hidden and never prompt; a repository Git can't reach is noted instead. The gateway itself starts at login with no console window, and the SSH tunnels run hidden too.
- **Installing without admin rights.** On Windows, when the administrator prompt is declined (or the account isn't an administrator), the Claude desktop app's settings now go in the per-user policy key, which the app reads too, so it can still run on the gateway. The web page works without admin rights at http://claude-nonstop.localhost (with the gateway's port when port 80 is taken).
- On Windows, sessions already on this computer are recognised when importing (the check used `grep`, which Windows doesn't have), and `codex cloud` no longer leaves an `error.log` in the folder it ran from.

## [1.23.1](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.23.1) · 2026-11-25

- Signing in a Gemini account that Google won't serve through Code Assist now says why, in Google's words, and points to a Gemini API key. Google no longer serves the free "Gemini Code Assist for individuals" tier to Gemini CLI's client, and the paid tier needs your own Google Cloud project with a Code Assist licence; Gemini API keys are unaffected.

## [1.23.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.23.0) · 2026-11-25

- **Gemini.** Add a Gemini account (Google sign-in, the way Gemini CLI signs in; Gemini Code Assist under the account's own plan) or a Gemini API key (`AIza…`), and any tool runs on it like any other line: Claude Code, Codex, Cursor and the desktop app, tool calls included. `accounts add "Name" --gemini`, or pick **Gemini** under **Add Account…**. A line not given the chosen model (a preview, or one whose quota is used up) gets the next Gemini model it serves.
- **The cable follows the line actually in use.** When an account hits its limit and the gateway moves on, the page's cable now moves with it; it used to stay on the first line the page thought was ready.
- **OpenAI API keys** of every current shape are taken (`sk-proj-…`, `sk-svcacct-…`, keys with dots). Without the gateway running, a terminal session no longer hands a non-Claude key to Claude Code.
- **Model lists are current.** The Settings pickers and `/v1/models` list what each service offers now, read with your keys and sign-ins (Claude Fable 5.2 and the GPT-6 family included), plus a Gemini picker. In dark mode the open dropdown list no longer shows white text on white.
- Fixes from a full review of the gateway: a conversation that moved to another provider and back to Claude or OpenAI no longer fails on the other provider's reasoning; a service that can't be reached moves on to the next line instead of ending the request; text split across network packets in translated answers keeps characters like — and emoji whole; a sign-in is renewed even after a model retry; a subscription account the desktop app runs on no longer counts as "on API keys"; ChatGPT usage is written once a minute, not after every answer; ChatGPT accounts are no longer passed to Claude's sign-in renewal.

## [1.22.2](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.22.2) · 2026-11-21

- GitHub keeps working in the desktop app until its updated settings are approved: 1.22.1 gave an app still on the earlier settings the gateway's key instead of GitHub's token, so GitHub answered "Authorization header is badly formatted".

## [1.22.1](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.22.1) · 2026-11-21

- GitHub's list tools (list_releases, list_tags and others) work in the desktop app. They failed with "Invalid tools/call result … expected record, received array": the app rejects a result whose structured part is a list. Connectors that sign in with a token now reach their server through the gateway, which drops that part (the same data stays in the result's text) and adds the token itself, so the token no longer reaches the app at all.

## [1.22.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.22.0) · 2026-11-21

- **Browse Connectors…** on the Apps tab (and `claude-nonstop connectors catalog`): search 480 ready-made connectors plus GitHub, tick the ones you want and add them in one go. They show in the desktop app's Connectors, where you sign in to each the first time.
- GitHub works. It doesn't let apps register their own sign-in, so the app said it needed an OAuth Client ID. It now signs in with your GitHub CLI sign-in, or a token you paste once, which claude-nonstop keeps encrypted and hands to the app only when it connects. A GitHub connector added before is fixed with the next settings update.
- **Add by Address…** checks how a server signs in and asks for an access token or API key only when it needs one (`connectors add <name> <url> --token <token>` on the command line).

## [1.21.1](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.21.1) · 2026-11-21

- Bringing cloud sessions here works for an account that's at its usage limit. The import was refused with the limit message, though reading cloud sessions spends none of the account's usage. Chats still skip that account until its limit resets.

## [1.21.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.21.0) · 2026-11-20

- **Merge Chats…** (and `claude-nonstop sessions chats` / `sessions merge`): pick Claude Code chats from any account or Codex, and what they merge into, one of them to continue or a new chat in a folder. The result is one chat: that conversation as it was, plus a condensed record of what each other chat asked and did. It shows in `claude --resume`, Codex and the desktop app's import; the originals stay as they are.

## [1.20.1](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.20.1) · 2026-11-20

- Imported chats keep their titles in the Claude desktop app: the title is now written at the start of each chat file too, where the app's importer reads it (it showed the first message, or "Terminal session"). Earlier imports are updated on the next import.

## [1.20.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.20.0) · 2026-11-20

- ChatGPT accounts bring their Codex Cloud threads, the Codex work at chatgpt.com/local/… and in the Codex app's cloud workspaces: each conversation (messages, commands with their output, app actions) becomes a chat that Claude Code, the Claude desktop app's import and your local Codex all continue, and the cloud workspace's files are copied into its project folder. Credential and tool folders (.aws, .codex, .git…) are never copied.

## [1.19.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.19.0) · 2026-11-20

- Imported cloud sessions become Codex threads too, through Codex's own importer: continue any of them in the Codex app or `codex resume` as well as in Claude Code. Earlier imports are handed over on the next import.
- The folders an import makes are trusted for Claude Code, so the Claude desktop app accepts their sessions; after an import its Import page opens (Cowork & Code adds them to the sidebar). Folders whose project settings run hooks or MCP servers are left for you to trust.
- Clearer import messages: "All 60 of SXL's cloud sessions are already on this computer" rather than what read like none, and an account with no Codex cloud tasks says so.

## [1.18.1](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.18.1) · 2026-11-20

- Imported sessions are opened with `claude --resume` in a terminal; the messages no longer say the desktop app's Code tab lists them (it keeps its own list).

## [1.18.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.18.0) · 2026-11-20

- Sessions and Codex tasks on the same repository, from any account, are merged into one project: one clone, every conversation resumable there, and a handoff note (what each did, what was last asked, where it ended) that new sessions in that folder read automatically. Earlier imports move into their project.
- **Bring All Cloud Sessions Here** and `claude-nonstop sessions import all` bring every connected account's cloud sessions in one go.

## [1.17.1](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.17.1) · 2026-11-20

- ChatGPT accounts bring their Codex cloud tasks here too: each task's details and diff, applied to a clone of its repository when the task names one.

## [1.17.0](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.17.0) · 2026-11-20

- Adding or signing in to a Claude account brings its Claude Code cloud sessions to this computer, as sessions `claude --resume` and the desktop app list, with their git repository cloned and the files they wrote rebuilt. Also from an account's menu and `claude-nonstop sessions import`.

## [1.16.4](https://github.com/umer-jahangier/claude-nonstop/releases/tag/v1.16.4) · 2026-11-20

- Fixes "SSL certificate verification failed (UNSUPPORTED_CONSTRAINT_TYPE)" in Claude Code and the Claude desktop app after 1.16.3. The local certificate now lists only DNS names: Claude Code runs on Bun, which refuses any certificate that lists an IP address under an authority with IP name constraints. The next `claude-nonstop setup` (run by the update) replaces a 1.16.3 certificate.

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
