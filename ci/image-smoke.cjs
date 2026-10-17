'use strict';
// This runs on the build runner only. Never start bot.js or mount credentials.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const image = process.argv[2];
if (!image || !/^(?:ghcr\.io\/ttnb-wd\/vpn-reseller-bot:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(image)) {
  throw new Error('Invalid image reference.');
}
const id = JSON.parse(execFileSync('docker', ['image', 'inspect', image]))[0].Id;
const files = require('../deploy/runtime-files.json');
const hashes = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const program = `'use strict';
const fs=require('fs'),path=require('path'),a=require('assert/strict'),c=require('crypto');
const expected=${JSON.stringify(hashes)};
for(const [file,hash]of Object.entries(expected))a.equal(c.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),hash);
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name).replaceAll('\\\\','/')]);}
for(const dir of ['src','prisma','assets','deploy'])for(const file of walk(dir))a.ok(Object.hasOwn(expected,file),'Unexpected runtime file');
a.equal(fs.existsSync('/app/.env'),false);
a.equal(Object.values(require('./src/database-pool').POOL_LIMITS).reduce((n,v)=>n+v,0),7);
a.ok(!process.env.DATABASE_URL&&!process.env.BOT_TOKEN);
console.log('Image content, seven-session budget and secret-free smoke: PASS');`;
const run = spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', '--memory', '192m',
  '--memory-swap', '192m', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
  '--pids-limit', '64', '--no-healthcheck', '--env', 'NODE_OPTIONS=--max-old-space-size=96',
  '--entrypoint', 'node', id, '-'], { input: program, stdio: ['pipe', 'inherit', 'inherit'] });
process.exitCode = run.status ?? 1;
