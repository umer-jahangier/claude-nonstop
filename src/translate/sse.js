'use strict';

// Server-sent events, both ways: a parser that turns a byte stream into { event, data }
// records, and a writer that prints them. Every provider streams answers this way.

// Feed chunks in; get complete records out. A record is complete at a blank line.
function parser() {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString('utf8');
    const out = [];
    let at;
    while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buffer.slice(0, at);
      buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, '');
      const record = { event: null, data: '' };
      const lines = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') record.event = value;
        else if (field === 'data') lines.push(value);
      }
      record.data = lines.join('\n');
      if (record.event !== null || record.data !== '') out.push(record);
    }
    return out;
  };
}

const format = (event, data) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

// Parsed data when it's JSON, else null.
function json(record) {
  try {
    return JSON.parse(record.data);
  } catch {
    return null;
  }
}

module.exports = { parser, format, json };
