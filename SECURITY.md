# Security policy

claude-nonstop holds API keys and talks to the services they belong to, so security reports get priority.

## Supported versions

Only the [latest release](https://github.com/umer-jahangier/claude-nonstop/releases/latest) receives fixes. The installer and `claude-nonstop update` keep you on it, and installs update themselves within the hour.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/umer-jahangier/claude-nonstop/security/advisories/new), or email **umer.jahangier@gmail.com** with "claude-nonstop security" in the subject.

Include what an attacker can do, the steps to reproduce it, and the version (`claude-nonstop --version`). You'll get an answer within a few days, and credit in the release notes if you'd like it.

## What claude-nonstop protects

- **API keys** are encrypted at rest (AES-256-GCM). The encryption key is held by the macOS Keychain, Windows DPAPI or the Linux Secret Service.
- **Each key is only sent to its own service:** Claude keys to `api.anthropic.com`, OpenAI keys to `api.openai.com`, ChatGPT sign-ins to `chatgpt.com`.
- **The gateway and the web page** accept connections from this computer only, and only under their own names. The gateway requires its own random token; the web page requires a one-time sign-in link and a header other websites can't send.
- **The local HTTPS certificate** is signed by a certificate authority whose private key is discarded right after use, so it can't sign anything else.

Out of scope: other programs running as your user on the same computer, which can read your files and talk to localhost like you can.
