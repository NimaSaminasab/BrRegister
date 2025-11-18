const fs = require('fs');
const path = require('path');

const LIMIT = parseInt(process.env.TRIM_LIMIT || '50', 10);
const INPUT = path.join(__dirname, '..', 'data', 'companies.json');

const input = fs.createReadStream(INPUT, { encoding: 'utf8' });

let objects = [];
let collecting = false;
let buffer = '';
let depth = 0;
let inString = false;
let escaped = false;

function resetState() {
  collecting = false;
  buffer = '';
  depth = 0;
  inString = false;
  escaped = false;
}

input.on('data', (chunk) => {
  for (let i = 0; i < chunk.length; i += 1) {
    const char = chunk[i];

    if (!collecting) {
      if (char === '{') {
        collecting = true;
        buffer = '{';
        depth = 1;
      }
      continue;
    }

    buffer += char;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"' && !escaped) {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        try {
          objects.push(JSON.parse(buffer));
        } catch (error) {
          input.destroy(error);
          return;
        }

        if (objects.length >= LIMIT) {
          input.destroy();
          return;
        }

        resetState();
      }
    }
  }
});

input.on('close', () => {
  const output = JSON.stringify(objects, null, 2);
  fs.writeFileSync(INPUT, `${output}\n`, 'utf8');
  console.log(`Trimmed to ${objects.length} companies`);
});

input.on('error', (error) => {
  console.error('Failed to trim companies.json', error);
  process.exit(1);
});

