# Contributing to claude-nonstop

Thanks for helping. claude-nonstop is maintained by [Muhammad Umer (Umer Jahangier)](https://github.com/umer-jahangier).

## Reporting a problem

Open an [issue](https://github.com/umer-jahangier/claude-nonstop/issues) with:

- what you ran and what happened, and what you expected instead;
- the output of `claude-nonstop status` (it masks keys, but check before pasting);
- the relevant lines from `~/.claude-nonstop/claude-nonstop.log` and `~/.claude-nonstop/gateway.log`;
- your operating system, and the client involved (Claude Code, Codex, the Claude desktop app, Cursor).

Never paste a full API key, a sign-in token or the gateway token. For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Questions and ideas

Use [Discussions](https://github.com/umer-jahangier/claude-nonstop/discussions) for questions, setup help and feature ideas.

## Changing the code

```bash
git clone https://github.com/umer-jahangier/claude-nonstop
cd claude-nonstop
npm test
```

- **No dependencies.** The tool runs on Node.js 18 or newer with only its standard library. Please keep it that way.
- **Tests run against fakes.** A fake Claude API, a fake OpenAI API and a fake `claude` binary live in `test/helpers.js` and `fixtures/`. Add a test next to the change you make.
- **CI** runs `npm test` on macOS, Windows and Linux with Node 18, 20 and 22, then the installers end to end. A pull request should pass all of them.
- **The web page** is one file, `src/ui/index.html`, and follows [DESIGN.md](DESIGN.md).
- **Writing.** Commit messages, README text and UI copy are plain sentences that say what changed for the person using it.

Keep a pull request to one change, and describe how you tested it.

## Licence

By contributing you agree that your contribution is released under the [MIT License](LICENSE).
