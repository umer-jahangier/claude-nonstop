'use strict';

// Terminal prompts: a yes/no question, and a hidden input for pasting an API key.

const readline = require('readline');

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(question, defaultYes = true) {
  if (!process.stdin.isTTY) return defaultYes;
  const answer = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

// Reads a secret without echoing it. With a pipe on stdin, reads the pipe instead.
function secret(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => (data += d));
      stdin.on('end', () => resolve(data.trim()));
    });
  }
  return new Promise((resolve) => {
    process.stderr.write(question);
    let value = '';
    const finish = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      // Some terminals wrap pasted text in bracketed-paste markers.
      resolve(value.replace(/\x1b\[20[01]~/g, '').trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
      return undefined;
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

module.exports = { ask, confirm, secret };
