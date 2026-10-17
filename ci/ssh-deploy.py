"""Runner-side client. Only a digest/revision/job ID is sent to the forced receiver."""
import json, os, re, subprocess, sys, tempfile, time
from pathlib import Path


def main():
    image, revision = os.environ['METRO_IMAGE'], os.environ['GITHUB_SHA']
    if not re.fullmatch(r'ghcr\.io/ttnb-wd/vpn-reseller-bot@sha256:[a-f0-9]{64}', image):
        raise ValueError('Invalid immutable image')
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Invalid revision')
    host, user = os.environ['METRO_SSH_HOST'], os.environ['METRO_SSH_USER']
    if not re.fullmatch(r'[A-Za-z0-9.-]+', host) or user != 'metro-deploy':
        raise ValueError('Invalid dedicated SSH endpoint')
    run = os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']
    if not re.fullmatch(r'[0-9]+-[0-9]+', run):
        raise ValueError('Invalid run ID')
    with tempfile.TemporaryDirectory(prefix='metro-ssh-', dir=os.environ.get('RUNNER_TEMP')) as temp:
        os.chmod(temp, 0o700)
        key, hosts = Path(temp) / 'key', Path(temp) / 'known_hosts'
        key.write_text(os.environ.pop('METRO_SSH_KEY') + '\n')
        hosts.write_text(os.environ.pop('METRO_KNOWN_HOSTS') + '\n')
        os.chmod(key, 0o600)
        os.chmod(hosts, 0o600)
        # No ssh-keyscan, agent forwarding, remote shell command, or sudo arguments.
        args = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
                '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
                '-o', 'ServerAliveCountMax=2', '-o', 'UserKnownHostsFile=' + str(hosts),
                '-i', str(key), user + '@' + host]

        def request(payload):
            child = subprocess.run(args, input=json.dumps(payload), text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=70)
            if child.returncode:
                raise RuntimeError('SSH transport failed; raw diagnostic suppressed')
            return json.loads(child.stdout)

        result = request({'op': 'submit', 'run': run, 'image': image, 'revision': revision})
        if result.get('outcome') != 'accepted':
            raise RuntimeError('Deployment not accepted')
        deadline = time.monotonic() + 840
        while time.monotonic() < deadline:
            time.sleep(5)
            result = request({'op': 'status', 'run': run})
            outcome = result.get('outcome')
            if outcome in ('deployed', 'rolled-back', 'failed-before-stop', 'needs-attention'):
                print(json.dumps({k: result[k] for k in
                                 ('outcome', 'revision', 'image', 'interruptionSeconds', 'memoryBytes')
                                 if k in result}))
                return 0 if outcome == 'deployed' else 1
        raise RuntimeError('Timed out; on-host deployment continues independently; inspect private status')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Deployment client failed; inspect on-host sanitized status. No credentials printed.', file=sys.stderr)
        sys.exit(1)
