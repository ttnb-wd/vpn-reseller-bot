#!/usr/bin/python3 -I
"""Root-owned, forced-command receiver. Install once by a separately approved step.

Never execute a helper fetched from an image or checkout on the host. The only
runner-controlled inputs are a validated registry digest, revision and run ID.
"""
import contextlib
import copy
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path('/var/lib/metro-vpn-ci')
CONFIG = Path('/etc/metro-vpn/ci.json')
PROGRAM = '/usr/local/libexec/metro-ci-deploy.py'
REPOSITORY = 'https://github.com/ttnb-wd/vpn-reseller-bot'
CAP = 192 * 1024 ** 2


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def validate_request(value):
    require(type(value) is dict, 'Invalid request')
    require(value.get('op') in ('submit', 'status'), 'Invalid operation')
    expected = {'op', 'run', 'image', 'revision'} if value['op'] == 'submit' else {'op', 'run'}
    require(set(value) == expected, 'Unexpected request fields')
    require(re.fullmatch(r'[0-9]{1,20}-[0-9]{1,5}', str(value['run'])), 'Invalid run')
    if value['op'] == 'submit':
        require(re.fullmatch(r'ghcr\.io/ttnb-wd/vpn-reseller-bot@sha256:[a-f0-9]{64}', str(value['image'])), 'Invalid image')
        require(re.fullmatch(r'[a-f0-9]{40}', str(value['revision'])), 'Invalid revision')
    return value


def trusted(file, private=False):
    file = Path(file)
    require(file.is_absolute() and file.is_file() and not file.is_symlink(), 'Untrusted file')
    for item in (file, *file.parents):
        info = item.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'Untrusted ownership or permissions')
    if private:
        require(not file.stat().st_mode & 0o077, 'Private file permissions required')
    return file


def write_json(file, value):
    file = Path(file)
    temporary = file.with_suffix(file.suffix + '.tmp')
    with open(temporary, 'w', encoding='utf8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)
    directory = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def command(args, payload=None, timeout=90):
    child = subprocess.run(args, input=payload, text=True, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=timeout, env={
                               'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
                               'LANG': 'C.UTF-8', 'DOCKER_CONFIG': '/etc/metro-vpn/docker'})
    require(child.returncode == 0, 'Private subprocess gate failed')
    return child.stdout + child.stderr if args[:2] == ['docker', 'logs'] else child.stdout


@contextlib.contextmanager
def deployment_lock():
    import fcntl  # Host is Linux; importing pure helpers stays portable for unit tests.
    with open(ROOT / 'deployment.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def transaction(host, request):
    """Testable ordering. No candidate starts until old process and DB owner are gone."""
    stopped = False
    try:
        host.preflight(request)
        host.prepare(request)
        # Persist recovery intent BEFORE stop, including full rollback configuration.
        host.journal(True)
        stopped = True
        host.stop()
        host.quiescent()
        host.start(False)
        host.verify(False)
        host.journal(False)
        return 'deployed'
    except Exception:
        if not stopped:
            return 'failed-before-stop'
        try:
            host.stop()
            host.quiescent()
            host.start(True)
            host.verify(True)
            host.journal(False)
            return 'rolled-back'
        except Exception:
            # Keep recovery journal pending; never restore a database snapshot.
            return 'needs-attention'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Host:
    def __init__(self, folder, config, run=command, sleep=time.sleep):
        self.folder, self.config, self.run, self.sleep = Path(folder), config, run, sleep
        self.container = config['container']
        require(self.container == 'metro-vpn-bot-1', 'Only Metro bot may be replaced')
        require(config['hostname'] == 'metrosecure.duckdns.org', 'Unexpected public host')
        require(config['registry'] == 'ghcr.io/ttnb-wd/vpn-reseller-bot', 'Unexpected registry')
        require(config['database'] == 'metro_production' and config['database_role'] == 'metro_app', 'Unexpected database identity')
        require(re.fullmatch(r'[a-z0-9.-]+\.aivencloud\.com', config['database_host']), 'Verify Aiven host before activation')
        require(re.fullmatch(r'[a-f0-9]{64}', config['compose_sha256']), 'Pin approved runtime configuration')
        self.maximum_memory, self.interruption = 0, None

    def inspect(self, name=None):
        return json.loads(self.run(['docker', 'inspect', name or self.container]))[0]

    def compose(self, file, *arguments):
        return self.run(['docker', 'compose', '--project-name', 'metro-vpn', '--file',
                         str(file), *arguments], timeout=120)

    def environment(self, container):
        return dict(item.split('=', 1) for item in (container['Config'].get('Env') or []))

    def file_hash(self, file):
        return hashlib.sha256(Path(file).read_bytes()).hexdigest()

    def preflight(self, request):
        self.request = request
        self.resource_gate()
        active = trusted(self.config['compose_file'], private=True)
        require(self.file_hash(active) == self.config['compose_sha256'], 'Approved runtime configuration drifted')
        self.before = self.inspect()
        require(self.before['State'].get('Health', {}).get('Status') == 'healthy', 'Incumbent is not healthy')
        self.runtime_gate(self.before, baseline=True)
        self.env = self.environment(self.before)
        self.bot_processes(1)
        networks = self.before['NetworkSettings']['Networks']
        require(len(networks) == 1, 'Expected one existing app network')
        self.network = next(iter(networks))
        self.ca = next(m['Source'] for m in self.before['Mounts'] if m['Destination'] == '/run/metro-vpn/aiven-ca.pem')
        trusted(self.ca)
        self.ca_hash = self.file_hash(self.ca)
        self.configured = json.loads(self.compose(active, 'config', '--no-env-resolution', '--format', 'json'))
        require(set(self.configured['services']) == {'bot'}, 'Unexpected Compose services')
        bot = self.configured['services']['bot']
        require(not any(k.startswith('x-') for k in self.configured), 'Unexpected Compose extensions')
        files = bot['env_file']
        require(len(files) == 1 and files[0]['format'] == 'raw', 'Expected one raw environment file')
        self.environment_file = str(trusted(files[0]['path'], private=True))
        self.environment_hash = self.file_hash(self.environment_file)
        self.db_gate(1)
        self.contract = self.image_probe(self.before['Image'])
        self.others = self.other_containers()
        self.caddy = self.file_hash(trusted('/etc/caddy/Caddyfile'))
        # Neither restarting services nor touching firewall/Outline/provider config is allowed.
        self.prepared = False

    def runtime_gate(self, container, baseline=False):
        host, conf = container['HostConfig'], container['Config']
        require(host['Memory'] == CAP and host['MemorySwap'] == CAP, '192 MiB cap/no swap required')
        require(host['ReadonlyRootfs'] and host['Init'], 'Read-only/init required')
        require('ALL' in (host['CapDrop'] or []) and any('no-new-privileges' in s for s in host['SecurityOpt']), 'Container restrictions required')
        require(host['PidsLimit'] == 128 and host['NanoCpus'] == 500000000, 'CPU/PID limits required')
        require(conf['User'] == '1000:1000' and self.environment(container)['NODE_OPTIONS'] == '--max-old-space-size=96', 'Runtime user/heap required')
        require(conf['Labels'].get('com.centurylinklabs.watchtower.enable') == 'false', 'Watchtower exclusion required')
        require(host['PortBindings'] == {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3000'}]}, 'Loopback binding required')
        if not baseline:
            require(self.environment(container) == self.env, 'Environment changed')
            for key in ('Memory', 'MemorySwap', 'MemoryReservation', 'NanoCpus', 'PidsLimit', 'ReadonlyRootfs',
                        'CapDrop', 'SecurityOpt', 'Tmpfs', 'RestartPolicy', 'PortBindings', 'Init', 'LogConfig', 'Binds', 'Mounts', 'NetworkMode'):
                require(host.get(key) == self.before['HostConfig'].get(key), 'Runtime configuration changed')
            require(conf['Healthcheck'] == self.before['Config']['Healthcheck'], 'Healthcheck changed')

    def bot_processes(self, expected):
        ids = self.run(['docker', 'ps', '--quiet']).split()
        running = json.loads(self.run(['docker', 'inspect', *ids])) if ids else []
        count = sum(self.environment(c).get('BOT_TOKEN') == self.env.get('BOT_TOKEN') for c in running)
        require(count == expected, 'Unexpected number of running bot containers')

    def other_containers(self):
        ids = self.run(['docker', 'ps', '--all', '--quiet']).split()
        values = json.loads(self.run(['docker', 'inspect', *ids])) if ids else []
        return {c['Name']: [c['Id'], c['Image'], c['State']['StartedAt'], c['RestartCount']]
                for c in values if c['Name'] != '/' + self.container}

    def infrastructure_gate(self):
        require(self.other_containers() == self.others, 'Unrelated container changed')
        require(self.file_hash('/etc/caddy/Caddyfile') == self.caddy, 'Caddy configuration changed')
        require(self.file_hash(self.environment_file) == self.environment_hash, 'Environment file changed')
        require(self.file_hash(self.ca) == self.ca_hash, 'Certificate file changed')
        require(self.file_hash(self.config['compose_file']) == self.config['compose_sha256'], 'Approved Compose file changed')

    def image_probe(self, image):
        program = """const fs=require('fs'),c=require('crypto'),a=require('assert/strict');
        a.equal(fs.existsSync('/app/.env'),false);
        a.equal(Object.values(require('./src/database-pool').POOL_LIMITS).reduce((x,y)=>x+y,0),7);
        console.log(JSON.stringify({contract:c.createHash('sha256').update(fs.readFileSync('prisma/contract.json')).digest('hex')}));"""
        args = ['docker', 'run', '--rm', '--network', 'none', '--memory', '64m', '--memory-swap', '64m',
                '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                '--pids-limit', '32', '--no-healthcheck', '--env', 'NODE_OPTIONS=--max-old-space-size=32',
                '--label', 'com.centurylinklabs.watchtower.enable=false', '--entrypoint', 'node', image, '-e', program]
        return json.loads(self.run(args))['contract']

    def db_gate(self, expected):
        # No bot module import, getUpdates, schema command or customer row query.
        program = """const fs=require('fs'),a=require('assert/strict'),{Client}=require('pg');
        (async()=>{const p=JSON.parse(fs.readFileSync(0,'utf8')),url=new URL(p.url);
        a.equal(url.hostname,p.host);a.equal(url.pathname,'/'+p.database);a.equal(url.username,p.role);
        const {prepareDatabaseUrl}=require('./src/db');const db=new Client({connectionString:prepareDatabaseUrl(p.url,'production').toString(),
        application_name:'metro-ci-readonly',connectionTimeoutMillis:5000,statement_timeout:5000,options:'-c default_transaction_read_only=on'});
        try{await db.connect();a.equal(db.connection.stream.authorized,true);await db.query('BEGIN READ ONLY');
        const role=(await db.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
        a.ok(Object.values(role).every(v=>v===false));
        const owners=(await db.query("SELECT s.usename,s.application_name FROM pg_locks l JOIN pg_stat_activity s ON s.pid=l.pid WHERE l.locktype='advisory' AND l.classid=1297302355 AND l.objid=0 AND l.objsubid=2 AND l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows;
        a.equal(owners.length,p.expected);a.ok(owners.every(o=>o.usename===p.role&&o.application_name==='metro-coordination'));
        const n=(await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ('metro-application','metro-coordination','metro-notifications','metro-sales')")).rows[0].n;a.ok(n<=7);
        await db.query('ROLLBACK');console.log(JSON.stringify({ok:true}));}finally{await db.end();}})().catch(()=>{console.log(JSON.stringify({ok:false}));process.exitCode=1;});"""
        args = ['docker', 'run', '--rm', '-i', '--network', self.network, '--memory', '96m', '--memory-swap', '96m',
                '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32',
                '--no-healthcheck', '--env', 'NODE_OPTIONS=--max-old-space-size=48',
                '--env', 'NODE_EXTRA_CA_CERTS=/run/metro-vpn/aiven-ca.pem',
                '--mount', 'type=bind,source=' + self.ca + ',target=/run/metro-vpn/aiven-ca.pem,readonly',
                '--label', 'com.centurylinklabs.watchtower.enable=false', '--entrypoint', 'node', self.before['Image'], '-e', program]
        payload = {'url': self.env['DATABASE_URL'], 'expected': expected, 'host': self.config['database_host'],
                   'database': self.config['database'], 'role': self.config['database_role']}
        require(json.loads(self.run(args, payload=json.dumps(payload), timeout=35))['ok'], 'Read-only singleton gate failed')

    def resource_gate(self):
        available = int(next(l for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:')).split()[1]) * 1024
        require(available >= 256 * 1024 ** 2, 'Host memory gate failed')
        require(shutil.disk_usage('/var/lib/docker').free >= 1024 ** 3, 'Host disk gate failed')

    def prepare(self, request):
        self.resource_gate()
        self.run(['docker', 'pull', '--platform', 'linux/amd64', request['image']], timeout=240)
        self.resource_gate()
        candidate = json.loads(self.run(['docker', 'image', 'inspect', request['image']]))[0]
        require(request['image'] in candidate['RepoDigests'], 'Digest mismatch')
        require(candidate['Os'] == 'linux' and candidate['Architecture'] == 'amd64', 'Unexpected platform')
        require(candidate['Config']['Labels'].get('org.opencontainers.image.revision') == request['revision'], 'Revision mismatch')
        require(candidate['Config']['Labels'].get('org.opencontainers.image.source') == REPOSITORY, 'Repository mismatch')
        require(candidate['Config']['User'] == 'node', 'Image user mismatch')
        require(candidate['Config']['Cmd'] == self.before['Config']['Cmd'] and candidate['Config']['Entrypoint'] == self.before['Config']['Entrypoint'], 'Startup command changed')
        require(candidate['Size'] <= 400 * 1024 ** 2, 'Oversized image')
        require(self.image_probe(request['image']) == self.contract, 'Schema contract changed; use separate migration')
        self.candidate_id = candidate['Id']
        self.run(['docker', 'image', 'inspect', self.before['Image']])
        self.run(['docker', 'tag', self.before['Image'], 'metro-vpn:rollback-' + request['run']])
        shutil.copyfile(self.environment_file, self.folder / 'rollback.env')
        shutil.copyfile(self.ca, self.folder / 'rollback-ca.pem')
        os.chmod(self.folder / 'rollback.env', 0o600)
        os.chmod(self.folder / 'rollback-ca.pem', 0o644)
        new = copy.deepcopy(self.configured)
        new['services']['bot'].pop('build', None)
        new['services']['bot']['image'] = request['image']
        write_json(self.folder / 'candidate.compose.json', new)
        old = copy.deepcopy(new)
        old['services']['bot']['image'] = self.before['Image']
        # Keep the same active mounts/environment; protected copies are available
        # for manual disaster recovery, but ordinary rollback changes IMAGE only.
        write_json(self.folder / 'rollback.compose.json', old)
        write_json(self.folder / 'context.private.json', {
            'before': self.before, 'config': self.config, 'environment_file': self.environment_file,
            'environment_hash': self.environment_hash, 'ca': self.ca, 'ca_hash': self.ca_hash,
            'network': self.network, 'others': self.others, 'caddy': self.caddy,
            'candidate_id': self.candidate_id, 'request': request})
        for file in ('candidate.compose.json', 'rollback.compose.json'):
            self.compose(self.folder / file, 'config', '--quiet')
        resolved = json.loads(self.compose(self.folder / 'candidate.compose.json', 'config', '--format', 'json'))
        environment = self.environment({'Config': {'Env': candidate['Config']['Env']}})
        environment.update({key: str(value).replace('$$', '$') for key, value in resolved['services']['bot']['environment'].items()})
        require(environment == self.env, 'Replacement environment differs before stop')
        self.infrastructure_gate()
        self.prepared = True

    def journal(self, pending):
        write_json(ROOT / 'pending.json', {'pending': pending, 'folder': str(self.folder)})

    def stop(self):
        if not hasattr(self, 'stop_time'):
            self.stop_time = time.monotonic()
        # Compose can remove the incumbent and then fail before creating a
        # candidate. A missing named container must still allow image rollback.
        ids = self.run(['docker', 'ps', '--all', '--filter', 'name=^/' + self.container + '$', '--quiet']).split()
        require(len(ids) <= 1, 'Ambiguous application container')
        if ids:
            current = self.inspect(ids[0])
            if current['State']['Running']:
                self.run(['docker', 'stop', '--time', '45', ids[0]], timeout=65)
            require(not self.inspect(ids[0])['State']['Running'], 'Bot stop not verified')

    def quiescent(self):
        self.bot_processes(0)
        # A lost remote TCP session can need the existing 60-second lease expiry.
        for attempt in range(14):
            try:
                self.db_gate(0)
                return
            except Exception:
                if attempt == 13:
                    raise
                self.sleep(5)

    def start(self, rollback):
        self.bot_processes(0)
        file = self.folder / ('rollback.compose.json' if rollback else 'candidate.compose.json')
        self.compose(file, 'up', '--detach', '--no-build', '--pull', 'never', '--no-deps', '--force-recreate', 'bot')

    def http_gate(self):
        client = urllib.request.build_opener(NoRedirect)
        for route, status in (('/live', 200), ('/ready', 200), ('/app/', 200), ('/admin/login', 200), ('/admin', 303)):
            request = urllib.request.Request('https://' + self.config['hostname'] + route)
            try:
                response = client.open(request, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                require(response.status == status, 'HTTPS readiness gate failed')
                if route == '/admin/login':
                    require(response.headers.get('Referrer-Policy') == 'same-origin', 'Admin policy changed')
                    require("form-action 'self'" in response.headers.get('Content-Security-Policy', ''), 'Admin CSP changed')
                    require(b'action="/admin/login"' in response.read(256000), 'Unexpected login target')

    def memory_gate(self, container):
        pid = container['State']['Pid']
        relative = next(l.split(':', 2)[2] for l in Path('/proc/' + str(pid) + '/cgroup').read_text().splitlines() if l.startswith('0::'))
        base = Path('/sys/fs/cgroup' + relative).resolve()
        require(str(base).startswith('/sys/fs/cgroup/'), 'Invalid cgroup')
        current = int((base / 'memory.current').read_text())
        events = dict(l.split() for l in (base / 'memory.events').read_text().splitlines())
        require(int((base / 'memory.max').read_text()) == CAP and current < CAP, 'Container memory gate failed')
        require(int((base / 'memory.swap.current').read_text()) == 0, 'Unexpected swap usage')
        require(all(int(events.get(k, 0)) == 0 for k in ('oom', 'oom_kill', 'max')), 'Container memory pressure detected')
        self.maximum_memory = max(self.maximum_memory, current)

    def verify(self, rollback):
        expected = self.before['Image'] if rollback else self.candidate_id
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            current = self.inspect()
            require(current['Image'] == expected and not current['State']['OOMKilled'] and current['RestartCount'] == 0, 'Image/restart/OOM gate failed')
            if current['State'].get('Health', {}).get('Status') == 'healthy':
                try:
                    self.http_gate()
                    break
                except Exception:
                    pass
            self.sleep(2)
        else:
            raise RuntimeError('Readiness deadline failed')
        self.interruption = round(time.monotonic() - self.stop_time, 3) if hasattr(self, 'stop_time') else None
        # Observe > one full usage-worker interval before declaring success.
        for _ in range(16):
            current = self.inspect()
            require(current['State']['Running'] and current['State']['Health']['Status'] == 'healthy' and
                    current['RestartCount'] == 0 and not current['State']['OOMKilled'], 'Post-start health degraded')
            self.runtime_gate(current)
            self.memory_gate(current)
            self.sleep(5)
        self.bot_processes(1)
        self.db_gate(1)
        self.http_gate()
        self.infrastructure_gate()
        logs = self.run(['docker', 'logs', '--since', current['State']['StartedAt'], self.container])
        require(all(s in logs for s in ('Singleton services ready.', 'PROCESSING recovery enabled.', 'Outline usage sync enabled')), 'Startup workers not verified')
        require(not any(s in logs for s in ('409: Conflict', 'terminated by other getUpdates', 'PROCESSING recovery failed.')), 'Polling/recovery failure')

    def load_recovery(self):
        saved = json.loads(trusted(self.folder / 'context.private.json', private=True).read_text())
        for key, value in saved.items():
            setattr(self, key, value)
        self.env = self.environment(self.before)
        require(self.file_hash(self.environment_file) == self.environment_hash and self.file_hash(self.ca) == self.ca_hash,
                'Do not override changed environment during recovery')


def recover(config):
    pointer = ROOT / 'pending.json'
    if not pointer.exists():
        return
    value = json.loads(trusted(pointer, private=True).read_text())
    if not value.get('pending'):
        return
    folder = Path(value['folder'])
    require(folder.parent == ROOT and re.fullmatch(r'[0-9]+-[0-9]+', folder.name), 'Invalid recovery pointer')
    host = Host(folder, config)
    host.load_recovery()
    host.stop()
    host.quiescent()
    host.start(True)
    host.verify(True)
    host.journal(False)
    write_json(folder / 'status.json', {'outcome': 'rolled-back', 'revision': host.request['revision']})


def read_configuration():
    require(os.geteuid() == 0, 'Root-owned receiver required')
    os.umask(0o077)
    trusted(PROGRAM)
    trusted(CONFIG, private=True)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    require(ROOT.stat().st_uid == 0 and stat.S_IMODE(ROOT.stat().st_mode) == 0o700 and not ROOT.is_symlink(), 'Invalid private state directory')
    return json.loads(CONFIG.read_text())


def execute(folder, config):
    with deployment_lock():
        recover(config)
        request = validate_request(json.loads(trusted(folder / 'request.json', private=True).read_text()))
        host = Host(folder, config)
        outcome = transaction(host, request)
        result = {'outcome': outcome, 'revision': request['revision'], 'image': request['image'],
                  'interruptionSeconds': host.interruption, 'memoryBytes': host.maximum_memory}
        write_json(folder / 'status.json', result)
        if outcome != 'deployed':
            raise RuntimeError('Deployment did not complete')


def main():
    config = read_configuration()
    if sys.argv[1:] == ['--recover']:
        with deployment_lock():
            recover(config)
        return
    if len(sys.argv) == 3 and sys.argv[1] == '--execute':
        run = sys.argv[2]
        require(re.fullmatch(r'[0-9]+-[0-9]+', run), 'Invalid private job')
        execute(ROOT / run, config)
        return
    require(len(sys.argv) == 1, 'Unexpected receiver arguments')
    require(not os.environ.get('SSH_ORIGINAL_COMMAND'), 'Remote shell commands are forbidden')
    request = validate_request(json.loads(sys.stdin.read(2049)))
    folder = ROOT / request['run']
    if request['op'] == 'status':
        result = json.loads(trusted(folder / 'status.json', private=True).read_text())
    else:
        folder.mkdir(mode=0o700)  # Replayed job IDs fail closed.
        write_json(folder / 'request.json', request)
        write_json(folder / 'status.json', {'outcome': 'accepted'})
        # A detached system service owns rollback even when the runner disconnects.
        command(['systemd-run', '--unit=metro-ci-' + request['run'], '--collect',
                 '--property=UMask=0077', '--property=RuntimeMaxSec=900',
                 '--property=MemoryMax=128M', '--property=MemorySwapMax=0', '--property=TasksMax=64',
                 '--property=OnFailure=metro-ci-recover.service',
                 '/usr/bin/python3', '-I', PROGRAM, '--execute', request['run']])
        result = {'outcome': 'accepted'}
    allowed = ('outcome', 'revision', 'image', 'interruptionSeconds', 'memoryBytes')
    print(json.dumps({key: result[key] for key in allowed if key in result}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Raw subprocess output, environment, DB diagnostics and customer data never leave host.
        print('{"outcome":"needs-attention"}', file=sys.stderr)
        sys.exit(1)
