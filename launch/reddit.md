# Reddit

Read each subreddit's rules and recent self-promotion threads before posting. Use the flair the subreddit asks for (often "Built with Claude" or "Showcase"). Post to one subreddit, wait a few days, then the other with different text.

---

## r/ClaudeCode

**Title:** I made a tool that moves Claude Code to my next account (then API keys) when I hit the usage limit

**Body:**

I'm the author. I got tired of long tasks stopping at "You've hit your session limit", so I built **claude-nonstop** (free, MIT, macOS/Windows/Linux).

How it works:
- Accounts and API keys sit in one order. Each session starts on the first account with usage left.
- When a turn stops on a limit, it runs `claude --resume` on the next line and tells Claude to continue. You see Claude Code restart for a second, then the work carries on.
- All accounts share one history, so `claude -c` works across them.
- API keys switch mid-request through a local gateway, so a key running out doesn't interrupt anything.
- When your account has usage again, the session moves back to it.

Every account must be your own (sharing a subscription is against Anthropic's terms).

Install: `curl -fsSL https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.sh | sh`

Repo: https://github.com/umer-jahangier/claude-nonstop
Guide to the usage limits: https://umer-jahangier.github.io/claude-nonstop/guides/claude-code-usage-limit/

Happy to answer questions, and I'd like to hear what breaks.

---

## r/ClaudeAI

Rule 7 (Showcase) is checked by a bot. The post must say you built it, that it was built with Claude Code or for Claude, how Claude Code helped, what it does, that it's free and how to try it, with little marketing and only the project link. A first version was removed for missing "how Claude helped" and for a site link and promo image, so: text post, no image, repository link only, flair "Built with Claude". After a removal, wait an hour before posting again.

**Title:** I built a tool with Claude Code that carries on a Claude Code session on my next account when I hit a usage limit

**Body:**

I built claude-nonstop, a free, open-source (MIT) tool for Claude Code and the Claude desktop app. When a Claude subscription hits its 5-hour or weekly limit, it carries on the same conversation on the next account in your list, and after the accounts, on your own API keys.

**What it does**

- You list your own accounts and API keys in the order you want them used.
- Each session starts on the first account that still has usage.
- When a turn stops on a limit, it resumes the same session (`claude --resume`) on the next account. All accounts share one history.
- API keys go through a small local gateway, so when one runs out of credit, the same request is retried on the next key.
- The Claude desktop app can use the same list through its third-party (gateway) mode.

**How Claude Code helped build it**

- **Getting the desktop app to work on both accounts and keys.** This was the hardest part. A subscription sign-in only accepts requests shaped like Claude Code's, while an API key should get a plain API request. In Claude Code sessions I described what the app sent and what came back, and Claude Code traced the differences (headers, the OAuth beta flag, the system prompt) and wrote the gateway changes. That became versions 1.14 and 1.15.
- **Noticing a limit without scraping the terminal.** claude-nonstop adds Claude Code's own `StopFailure` hook to each session. The hook fires when a turn stops on a usage limit and tells claude-nonstop which session to resume.
- **What I did:** decided how it should behave (accounts first, keys last, back to an account once it has usage again), tested every version on my own accounts, and reviewed and released each change. The tests run on macOS, Windows and Linux on every push.

**Free to try**

Free and MIT licensed, no paid tier. Install:

- macOS or Linux: `curl -fsSL https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.sh | sh`
- Windows (PowerShell): `irm https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.ps1 | iex`
- Or with npm: `npm install -g @umer-jahangier/claude-nonstop`, then `claude-nonstop setup`

It opens a page to add your accounts and keys; after that you run `claude` as usual.

**Notes**

- Use only your own accounts and keys. Sharing a subscription is against Anthropic's terms.
- Requests on an API key are billed as normal API usage.
- Keys are stored encrypted on your computer, and there's no telemetry.

Source: https://github.com/umer-jahangier/claude-nonstop

Questions and bug reports are welcome.
