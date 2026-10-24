# claude-nonstop

**Keep your coding agent working through plan limits.** When your Claude subscription hits its session or weekly limit, claude-nonstop starts the next session on your next account, and when every account is out, on your API keys, one by one. You keep typing `claude` like always.

```
account 1  →  account 2  →  …  →  API key 1  →  API key 2  →  …
```

- **Subscriptions first.** Every session starts on the first account that still has usage left. API keys are only used when every account is out.
- **Keys switch mid-session.** A local gateway sends each request with your first working key. If a key runs out of credit, the same request is sent again on the next key, and the session never notices.
- **Works in the terminal and the Claude desktop app** on macOS, Windows and Linux.
- **Secrets stay on your computer, encrypted.** API keys are stored with AES-256-GCM. The encryption key is held by the macOS Keychain, Windows DPAPI or the Linux Secret Service. Keys are only ever sent to Anthropic.
- **A web page at `https://claude.nonstop`** to add accounts, sign in, add and test keys, and set up the desktop app. Drag its cable onto any account or key to switch to it on the spot, and watch every request fly to Anthropic on the globe. Light, dark, or your computer's setting.

## Install

One command installs everything, including its own copy of Node.js and [Claude Code](https://code.claude.com/docs/en/setup) if it's missing.

**macOS and Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.ps1 | iex
```

The installer:

1. installs claude-nonstop, and a private Node.js, into `~/.claude-nonstop` (`%USERPROFILE%\.claude-nonstop` on Windows), plus Claude Code if it isn't installed;
2. gives the web page its short address, `https://claude.nonstop` (also `claude-nonstop`), with a certificate your computer trusts, so there's no "Not secure" warning. This needs your password once (one confirmation on Windows) for the hosts-file line, and macOS asks once more to trust the certificate. Say no and the page lives at `http://claude-nonstop.localhost` instead, which needs nothing;
3. sets up the Claude desktop app to run on your API keys, if it's installed (on macOS, System Settings opens with a profile to approve: one click);
4. starts the local gateway now and every time you log in;
5. makes plain `claude` go through claude-nonstop;
6. opens the web page so you can add your accounts and API keys.

It keeps itself up to date after that (`claude-nonstop update` updates right away). Prefer npm? `npm install -g github:umer-jahangier/claude-nonstop`, then run `claude-nonstop setup`.

## Set it up (about two minutes)

Run `claude-nonstop ui`, or open `http://claude.nonstop`. The first visit goes through a one-time link from `claude-nonstop ui`, so only you can use the page.

1. **Accounts.** Your normal Claude Code login is already the first account. Click **Add Account…** for each extra subscription you have. Anthropic's own sign-in page opens in your browser; sign in, and the account joins the relay.
2. **API keys.** Click **Add API Key…**, paste a key from [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys), and save. Each key is tested on the spot.
3. **Order.** Use **Move Up** and **Move Down** in a line's **…** menu. The top working line is used first. To use a particular line right now, drag the cable's plug onto it (or choose **Use This Key** in its menu); **Use Automatic** hands control back.

From then on, just run `claude` (or `claude-nonstop`) as usual:

```
$ claude
claude-nonstop: checking Main account...
claude-nonstop: Main account: You've hit your session limit · resets 3:45pm
claude-nonstop: checking Work...
claude-nonstop: using Work (subscription)
```

**Hit a limit in the middle of a session?** Type `/exit`, then `claude -c`. claude-nonstop starts the next line and Claude Code continues the same conversation. History is shared across all your accounts.

## The Claude desktop app

The installer sets the desktop app up for you, using the settings locations Anthropic documents for it ([configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration-format)):

- **Windows:** registry policy under `HKLM\SOFTWARE\Policies\Claude`, in the same confirmation as the short address.
- **Linux:** `/etc/claude-desktop/managed-settings.json`, in the same password prompt.
- **macOS:** a configuration profile. macOS only lets you approve profiles yourself, so System Settings opens with it: double-click **claude-nonstop for the Claude desktop app** and click **Install**.

Installed the desktop app later? Run `claude-nonstop desktop`, or click **Set Up Automatically** on the web page's **Desktop App** tab. Then quit and reopen the app. From then on, the desktop sign-in screen offers both: **Claude.ai** for your subscription, or the third-party option to run on your API keys with automatic key switching. Pick the third-party option when your subscription is out.

## Commands

| Command | What it does |
| --- | --- |
| `claude-nonstop [claude args]` | Start Claude Code on the first account or key with usage left |
| `claude-nonstop --api [args]` | Skip subscriptions and use API keys |
| `claude-nonstop --sub [args]` | Use subscription accounts only |
| `claude-nonstop ui` | Open the web page |
| `claude-nonstop status` | Show what's set up and what's in use |
| `claude-nonstop keys` | Test every API key |
| `claude-nonstop keys add [name]` | Save a key (typed hidden, or piped on stdin) |
| `claude-nonstop keys remove <n>` | Forget key number n |
| `claude-nonstop accounts` | List accounts and who each is signed in as |
| `claude-nonstop accounts add [name]` | Add an account and sign in to it |
| `claude-nonstop accounts login <n>` | Sign in to account n again |
| `claude-nonstop accounts check` | Check which accounts have usage left |
| `claude-nonstop accounts on/off <n>` | Turn account n on or off |
| `claude-nonstop accounts remove <n>` | Sign out of account n and remove it |
| `claude-nonstop desktop` | Set up the Claude desktop app |
| `claude-nonstop setup` | Run the whole setup again |
| `claude-nonstop service install / uninstall` | Start the gateway at login, or stop doing so |
| `claude-nonstop shell install / uninstall` | Make plain `claude` go through claude-nonstop, or undo it |
| `claude-nonstop update` | Install the newest version now (it also updates itself daily) |
| `claude-nonstop uninstall [--purge]` | Remove claude-nonstop (`--purge` also deletes your saved keys) |

Claude Code's own subcommands (`claude mcp`, `claude doctor`, `claude update`, `claude --version`, …) pass straight through without any account checks.

## How it works

**Choosing an account.** Before a session starts, claude-nonstop asks each account in order whether it has usage left. Each check is one tiny Haiku request, run by Claude Code itself. An account that hit its limit is skipped for 10 minutes before it's asked again (change this under **Timing**).

**Extra accounts.** Each extra account is its own Claude Code configuration folder (`CLAUDE_CONFIG_DIR`, the [documented way](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts) to stay signed in to several accounts). You sign in through Anthropic's own page, and the login is stored by Claude Code in its own credential store; claude-nonstop never sees or stores subscription credentials. Your history, settings, plugins, skills and MCP servers are shared with every account, so they all feel the same and `claude -c` works across them.

**API keys.** When the gateway is running, Claude Code talks to `http://127.0.0.1:43117`, which forwards each request to Anthropic with your first working key. A key that answers *credit balance too low*, *spend limit reached*, *invalid* or *not allowed* is marked used up, the same request goes out again on the next key, and the used-up key is skipped for 30 minutes before it's tried again, in case you topped it up. If the gateway isn't running, claude-nonstop hands Claude Code a key helper instead, which re-picks a key every two minutes.

**Rate limits (429) and outages (5xx).** These stay on the current key, since switching wouldn't help: keys in one organization share one rate limit, and Claude Code already retries them. If your keys belong to separate organizations and you want rate-limited keys skipped too, change one line in [`src/classify.js`](src/classify.js).

## Security

- Everything runs on your computer. The gateway and web page accept connections from this computer only, and answer only to their own names: `127.0.0.1`, `localhost`, `claude-nonstop.localhost`, and `claude.nonstop` / `claude-nonstop` while your hosts file points them here.
- The globe's "This computer" spot is guessed from your timezone inside the page. It's never sent anywhere.
- HTTPS uses a certificate made on your computer. The certificate authority that signs it is used once, for this computer's own names, and its private key is thrown away immediately: it's never saved, so it can never sign anything else. `claude-nonstop uninstall` removes it from your trusted certificates.
- API keys are encrypted at rest. The encryption key lives in the macOS Keychain, Windows DPAPI or the Linux Secret Service; headless Linux machines without one fall back to a file readable only by you (shown in the UI).
- The web UI needs a one-time link from `claude-nonstop ui`, which becomes an HttpOnly, SameSite=Strict cookie. Every API call also needs a custom header that other websites can't send, so pages you visit can't reach it.
- Full keys are never shown again after you save them; the UI shows a masked form.
- The gateway needs its own random token, so other programs on your computer can't spend your keys.
- Keys are only sent to `api.anthropic.com`.

## Fair use

claude-nonstop runs the unmodified Claude Code and uses only documented features. Every account and key you add must be your own: each teammate installs claude-nonstop and adds their own accounts and keys. Sharing a subscription account between people is against Anthropic's terms.

claude-nonstop is an independent project and isn't affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Troubleshooting

- **`claude` doesn't go through claude-nonstop.** Open a new terminal after installing. Check with `claude-nonstop status` (the `claude shortcut` line), or run `claude-nonstop shell install`.
- **An account says "Not signed in".** Run `claude-nonstop accounts login <n>`, or click the sign-in button on its line in the web UI.
- **Every key shows "used up".** Top one up at [platform.claude.com/settings/billing](https://platform.claude.com/settings/billing), then click **Test** on its line (or **Forget cooldowns**).
- **The desktop app says "Gateway was unreachable".** The gateway isn't running. Run `claude-nonstop service install` to start it now and at every login.
- **`claude.nonstop` doesn't open, or says "Not secure".** Run `claude-nonstop setup` again and allow the changes when asked, or use `http://claude-nonstop.localhost`. Typing it in the address bar? Include `https://` the first time, so the browser doesn't search for it.
- **Logs.** `~/.claude-nonstop/claude-nonstop.log` (choices and key switches) and `~/.claude-nonstop/gateway.log`.

## Uninstall

```bash
claude-nonstop uninstall          # keeps your saved keys
claude-nonstop uninstall --purge  # also deletes keys, accounts and settings
```

If you installed with npm, finish with `npm uninstall -g claude-nonstop`.

## Development

```bash
git clone https://github.com/umer-jahangier/claude-nonstop
cd claude-nonstop
npm test
```

No dependencies. Tests run against a fake Claude API and a fake `claude` binary, and CI runs them on macOS, Windows and Linux with Node 18, 20 and 22, plus the installers end to end.
