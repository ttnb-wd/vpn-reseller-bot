'use strict';
// Run from any directory. Creates a fresh allowlisted context; never starts Docker.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const inputs = ['Dockerfile', '.dockerignore', ...require('./runtime-files.json')];
function prepare() {
  const records = inputs.map(relative => {
    if (path.isAbsolute(relative) || relative.includes('..') || relative.includes('\\') ||
        /(?:^|\/)(?:\.env[^/]*|backups|node_modules|\.git)(?:\/|$)|\.(?:sql|dump|env)$/.test(relative)) {
      throw new Error('Forbidden build input.');
    }
    const full = path.join(root, relative);
    if (!fs.lstatSync(full).isFile() || !fs.realpathSync(full).startsWith(fs.realpathSync(root) + path.sep)) {
      throw new Error('Build input is not a regular file within this workspace.');
    }
    const bytes = fs.readFileSync(full);
    return { relative, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  fs.mkdirSync(path.join(root, '.migration-validation'), { recursive: true });
  const destination = fs.mkdtempSync(path.join(root, '.migration-validation', 'context-'));
  for (const { relative, bytes } of records) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
  fs.writeFileSync(destination + '.manifest.json', JSON.stringify(records.map(({ relative, sha256 }) => ({ relative, sha256 })), null, 2));
  console.log(JSON.stringify({ context: destination, files: records.length, manifest: destination + '.manifest.json' }));
  return destination;
}
if (require.main === module) prepare();
module.exports = { prepare };
