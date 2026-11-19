# Show HN

**Title** (80 characters max):

Show HN: claude-nonstop – keep Claude Code working through usage limits

**URL:** https://github.com/umer-jahangier/claude-nonstop

**First comment** (post it right after submitting):

Hi HN, I built claude-nonstop because I kept losing the middle of long Claude Code tasks to "You've hit your session limit · resets 3:45pm".

It's a small local tool (Node, no dependencies, MIT) that sits between your coding tools and the APIs:

- Your accounts and API keys go in one ordered list. Each Claude Code session starts on the first account with usage left.
- When a turn stops on a limit, it reopens the same conversation on the next line with `claude --resume` and tells Claude to continue. When the account comes back, the session moves back so you don't keep spending API credit.
- API keys switch mid-request through a gateway on 127.0.0.1: if a key says "credit balance too low", the same request goes out on the next key and the session never notices.
- The gateway also speaks OpenAI's Responses and Chat Completions APIs, so Codex and Cursor can use the same order, and requests are translated between the two formats, tool calls and streaming included.

Keys are encrypted with the key in the OS keychain/DPAPI/Secret Service, nothing leaves your machine except requests to Anthropic/OpenAI and update checks to GitHub, and there's no telemetry.

The honest caveat: each provider takes a subscription sign-in only from its own client. Running Codex on a Claude subscription (or the reverse) isn't covered by their terms, so that part is your call; API keys don't have that issue. Every account you add has to be your own.

Install is one line (`curl … | sh`, or `npm i -g @umer-jahangier/claude-nonstop`). Site with guides: https://umer-jahangier.github.io/claude-nonstop/

I'd love feedback on the failover logic, and on anything that breaks on your setup.
