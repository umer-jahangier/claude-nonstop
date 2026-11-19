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

**Title:** Open-source tool: keep Claude Code and the Claude desktop app running when a subscription hits its limit

**Body:**

Disclosure: I built this. **claude-nonstop** is a free, open-source tool that keeps Claude Code, the Claude desktop app and Codex working when your plan hits its 5-hour or weekly limit, by moving to your next account and then to your own API keys.

The part people ask about most is the desktop app: it uses the app's documented third-party mode, so the app walks your order (subscription accounts first, then keys), and your claude.ai chats can be brought over with the app's own import.

A few honest notes:
- It only uses your own accounts and keys; nothing is shared or pooled.
- On API keys, requests go out as plain API requests, so they're billed as normal API usage.
- Keys are encrypted locally (OS keychain), with no telemetry.

Repo: https://github.com/umer-jahangier/claude-nonstop · Site: https://umer-jahangier.github.io/claude-nonstop/
