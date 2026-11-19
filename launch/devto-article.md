---
title: How I keep Claude Code running through usage limits
published: false
description: Claude Code stops at its 5-hour and weekly limits. Here's the open-source tool I built to move the same conversation to my next account, then my API keys.
tags: claude, ai, productivity, opensource
canonical_url:
cover_image: https://umer-jahangier.github.io/claude-nonstop/og.png
---

I use Claude Code for long tasks, the kind that run for an hour while I do something else. The most frustrating thing about it wasn't the model; it was coming back to this:

> You've hit your session limit · resets 3:45pm

The task stopped halfway, and the context was sitting there, waiting for the reset.

## What the limits are

A Claude subscription has two limits: a rolling **session** window of about five hours, and a **weekly** limit. When either runs out, Claude Code ends the current turn. You can wait, switch to another account by hand, or use an API key, which has no session limit but costs per token.

I had a work account and a personal one, and some API credit. Everything I needed was there; I just had to notice the limit, quit, change configuration folders and resume. So I automated it.

## claude-nonstop

[claude-nonstop](https://github.com/umer-jahangier/claude-nonstop) is a small tool (Node, no dependencies, MIT) that keeps one ordered list of your accounts and keys:

```
account 1  →  account 2  →  …  →  API key 1  →  API key 2  →  …
```

**Before a session starts**, it asks each account in order whether it has usage left, and starts Claude Code on the first one that does.

**When a limit hits mid-task**, a Claude Code hook tells it. It checks the next lines and runs `claude --resume <session> "Continue where you left off."` on the first one with usage. All the accounts share one history, so it really is the same conversation.

**API keys switch mid-request.** Requests go through a local gateway. If a key answers "credit balance too low", the gateway sends the same request on the next key, so the session never notices.

**It comes back.** When an account above the keys has usage again, the session moves back to it after the current turn, so you don't keep paying for API usage.

## Beyond Claude Code

The same gateway speaks OpenAI's Responses and Chat Completions APIs, so Codex and Cursor can use the same order, and it sets up the Claude desktop app's third-party mode. Requests are translated between Anthropic's and OpenAI's formats when needed, tool calls and streaming included.

One caveat I'd rather say up front: each provider takes a subscription sign-in only from its own client, so running one company's subscription from the other's tool isn't covered by their terms. API keys don't have that problem, and every account you add should be your own.

## Try it

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.sh | sh
```

Windows (PowerShell): `irm https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.ps1 | iex`, or `npm install -g @umer-jahangier/claude-nonstop`.

It opens a local page where you add accounts (each signs in on Anthropic's own page) and keys. Keys are encrypted with the key in your OS keychain, and there's no telemetry.

- Repo: https://github.com/umer-jahangier/claude-nonstop
- Guides: https://umer-jahangier.github.io/claude-nonstop/guides/

If you try it, I'd like to hear what breaks.
