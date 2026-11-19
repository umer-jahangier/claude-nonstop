# Answering existing questions

Only reply where claude-nonstop really solves the problem being asked about. Say you're the author, answer the question first, and link once.

## Open GitHub issues on anthropics/claude-code (checked November 19, 2026)

| Issue | Fit |
| --- | --- |
| [#30031 Support multiple account login and switching (like `gh auth switch`)](https://github.com/anthropics/claude-code/issues/30031) (19 comments) | Good: it's exactly multi-account switching |
| [#55621 Multi-account support in VSCode extension](https://github.com/anthropics/claude-code/issues/55621) (19 comments) | Partial: the VS Code extension reads Claude Code's settings, which setup points at the gateway |
| [#109077 Bind accounts to config directories in the account switcher](https://github.com/anthropics/claude-code/issues/109077) | Partial: claude-nonstop uses one config directory per account |

**Reply template** (adapt it to the thread):

> Until this is built in: I maintain an open-source workaround, claude-nonstop (https://github.com/umer-jahangier/claude-nonstop). It keeps one `CLAUDE_CONFIG_DIR` per account (the documented approach), shares history between them, and when a session hits its limit it resumes the same conversation on the next account with `claude --resume`. Disclosure: I'm the author. Happy to answer questions about how it does the switching.

Don't post this on feature requests where people are discussing Anthropic's design, and don't repeat it on several issues the same day: maintainers treat that as spam.

## Reddit and elsewhere

Search for recent threads with: `"session limit" claude code`, `"weekly limit" claude code`, `claude code multiple accounts`. Answer only threads from the last few weeks, where the person is asking how to keep working.
