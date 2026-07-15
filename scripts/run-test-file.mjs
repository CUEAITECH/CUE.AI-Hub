import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];

if (!target) {
  console.error('usage: node scripts/run-test-file.mjs <test-file>');
  process.exit(2);
}

try {
  await import(pathToFileURL(resolve(target)).href);
  process.exit(0);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
