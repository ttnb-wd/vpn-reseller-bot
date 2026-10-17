'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SystemRoot|SYSTEMDRIVE|WINDIR|TEMP|TMP|COMSPEC|APPDATA|LOCALAPPDATA|USERPROFILE)$/i.test(key)));
env.NODE_ENV = 'test';
env.NODE_OPTIONS = '';
const files = fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.test.cjs')).map(f => 'src/' + f)
  .concat(['deploy/legacy-forwarder.test.cjs', 'deploy/link-continuity.test.cjs']);
if (files.length !== 40) throw new Error('Update the reviewed test inventory before changing coverage.');
const result = spawnSync(process.execPath, ['--require', './ci/test-preload.cjs', '--test',
  '--test-concurrency=1', ...files], { cwd: root, env, stdio: 'inherit', timeout: 240000 });
process.exitCode = result.status ?? 1;
