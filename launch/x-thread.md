# X / LinkedIn

**Post 1**
I kept losing long Claude Code tasks to "You've hit your session limit".

So I built claude-nonstop: when an account runs out, the same conversation continues on my next account, then my API keys. Free and open source.

https://github.com/umer-jahangier/claude-nonstop

**Post 2**
How it works:
→ accounts and keys in one order
→ each session starts on the first with usage left
→ at a limit: `claude --resume` on the next line, and Claude continues
→ keys switch mid-request through a local gateway
→ back to the subscription when it resets

**Post 3**
It also runs Codex, Cursor and the Claude desktop app through the same order, translating between Anthropic's and OpenAI's APIs.

macOS, Windows, Linux. One-line install. Keys stay encrypted on your machine.

https://umer-jahangier.github.io/claude-nonstop/

---

**LinkedIn** (one post): use posts 1–3 as one, and add a sentence on what you learned building it, for example translating tool calls between the two APIs.
