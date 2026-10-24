#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === 'number') process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`claude-nonstop: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  },
);
