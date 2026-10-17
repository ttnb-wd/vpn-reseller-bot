"""Provider-free fault injection for the root-owned receiver's transaction."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('metro_ci', Path(__file__).with_name('ci-deploy.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)

REQUEST = {'op': 'submit', 'run': '123-1', 'revision': 'a' * 40,
           'image': 'ghcr.io/ttnb-wd/vpn-reseller-bot@sha256:' + 'b' * 64}


class FakeHost:
    def __init__(self, failure=None, rollback_fails=False):
        self.failure, self.rollback_fails = failure, rollback_fails
        self.calls, self.running, self.maximum_running, self.starts = [], 1, 1, 0

    def call(self, name):
        self.calls.append(name)
        if self.failure == name:
            self.failure = None
            raise RuntimeError('Synthetic fault')

    def preflight(self, request): self.call('preflight')
    def prepare(self, request): self.call('prepare')
    def journal(self, value): self.call('journal:' + str(value))

    def stop(self):
        self.call('stop')
        self.running = 0

    def quiescent(self):
        self.call('zero-owner')
        assert self.running == 0
        if self.rollback_fails:
            raise RuntimeError('Singleton never cleared')

    def start(self, rollback):
        self.call('start-old' if rollback else 'start-new')
        assert self.running == 0
        self.starts += 1
        self.running += 1
        self.maximum_running = max(self.maximum_running, self.running)

    def verify(self, rollback): self.call('verify-old' if rollback else 'verify-new')


class TransactionTests(unittest.TestCase):
    def test_order_and_no_overlap(self):
        host = FakeHost()
        self.assertEqual(ci.transaction(host, REQUEST), 'deployed')
        self.assertEqual(host.calls, ['preflight', 'prepare', 'journal:True', 'stop', 'zero-owner',
                                      'start-new', 'verify-new', 'journal:False'])
        self.assertEqual(host.maximum_running, 1)

    def test_preflight_failures_never_stop_incumbent(self):
        for phase in ('preflight', 'prepare', 'journal:True'):
            with self.subTest(phase=phase):
                host = FakeHost(phase)
                self.assertEqual(ci.transaction(host, REQUEST), 'failed-before-stop')
                self.assertEqual(host.running, 1)
                self.assertNotIn('stop', host.calls)

    def test_failed_health_start_and_journal_roll_back_in_order(self):
        for phase in ('stop', 'zero-owner', 'start-new', 'verify-new', 'journal:False'):
            with self.subTest(phase=phase):
                host = FakeHost(phase)
                self.assertEqual(ci.transaction(host, REQUEST), 'rolled-back')
                self.assertEqual(host.maximum_running, 1)
                self.assertEqual(host.calls[-4:], ['zero-owner', 'start-old', 'verify-old', 'journal:False'])

    def test_uncleared_singleton_never_starts_any_replacement(self):
        host = FakeHost(rollback_fails=True)
        self.assertEqual(ci.transaction(host, REQUEST), 'needs-attention')
        self.assertEqual(host.starts, 0)
        self.assertNotEqual(host.calls[-1], 'journal:False')

    def test_request_is_digest_only_and_cannot_inject_shell_or_paths(self):
        ci.validate_request(REQUEST)
        mutations = {'image': ['ghcr.io/ttnb-wd/vpn-reseller-bot:latest',
                               'evil.invalid/bot@sha256:' + 'b' * 64, REQUEST['image'] + ';id'],
                     'run': ['../123', '123\n1', 'abc', ''], 'revision': ['HEAD', 'a' * 39]}
        for key, values in mutations.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    request = dict(REQUEST, **{key: value})
                    with self.assertRaises(RuntimeError): ci.validate_request(request)
        with self.assertRaises(RuntimeError): ci.validate_request(dict(REQUEST, command='id'))
        with self.assertRaises(RuntimeError): ci.validate_request({'op': 'shell', 'run': '1-1'})
        ci.validate_request({'op': 'status', 'run': '1-1'})

    def test_host_rejects_other_services_hosts_and_database_targets(self):
        config = json.loads(Path(__file__).with_name('ci-host-config.example.json').read_text())
        config['database_host'] = 'synthetic.aivencloud.com'
        ci.Host(Path('.'), config)
        for key, value in [('container', 'outline'), ('registry', 'evil.invalid/x'),
                           ('database', 'old_database'), ('database_role', 'avnadmin'),
                           ('database_host', 'db.neon.tech'), ('hostname', 'legacy.onrender.com')]:
            with self.subTest(key=key):
                with self.assertRaises(RuntimeError): ci.Host(Path('.'), dict(config, **{key: value}))

    def test_runtime_gate_rejects_weakened_memory_identity_network_and_isolation(self):
        config = json.loads(Path(__file__).with_name('ci-host-config.example.json').read_text())
        config['database_host'] = 'synthetic.aivencloud.com'
        host = ci.Host(Path('.'), config)
        container = {'HostConfig': {'Memory': ci.CAP, 'MemorySwap': ci.CAP, 'ReadonlyRootfs': True,
                     'Init': True, 'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'],
                     'PidsLimit': 128, 'NanoCpus': 500000000,
                     'PortBindings': {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3000'}]}},
                     'Config': {'Env': ['NODE_OPTIONS=--max-old-space-size=96'], 'User': '1000:1000',
                                'Labels': {'com.centurylinklabs.watchtower.enable': 'false'}}}
        host.runtime_gate(container, baseline=True)
        for key, value in [('Memory', 512 * 1024**2), ('MemorySwap', 512 * 1024**2),
                           ('ReadonlyRootfs', False), ('Init', False), ('CapDrop', []),
                           ('SecurityOpt', []), ('PidsLimit', 0), ('NanoCpus', 0),
                           ('PortBindings', {'3000/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '3000'}]})]:
            with self.subTest(key=key):
                changed = copy.deepcopy(container)
                changed['HostConfig'][key] = value
                with self.assertRaises(RuntimeError): host.runtime_gate(changed, baseline=True)
        for key, value in [('User', 'root'), ('Env', ['NODE_OPTIONS=--max-old-space-size=192']),
                           ('Labels', {'com.centurylinklabs.watchtower.enable': 'true'})]:
            with self.subTest(key=key):
                changed = copy.deepcopy(container)
                changed['Config'][key] = value
                with self.assertRaises(RuntimeError): host.runtime_gate(changed, baseline=True)

    def test_source_has_no_build_schema_or_infrastructure_mutations(self):
        text = Path(__file__).with_name('ci-deploy.py').read_text()
        for forbidden in ('pg_restore', 'CREATE TABLE', 'ALTER TABLE', 'prisma migrate', 'docker.sock',
                          "['docker', 'build'", "['systemctl', 'restart'", "['ufw'", "['docker', 'compose', 'down'"):
            self.assertNotIn(forbidden, text)
        self.assertIn("'--no-build', '--pull', 'never', '--no-deps'", text)
        self.assertIn('default_transaction_read_only=on', text)
        self.assertIn("'--property=OnFailure=metro-ci-recover.service'", text)
        self.assertIn('RuntimeMaxSec=900', text)

    def test_missing_container_after_partial_compose_failure_does_not_block_rollback(self):
        config = json.loads(Path(__file__).with_name('ci-host-config.example.json').read_text())
        config['database_host'] = 'synthetic.aivencloud.com'
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            self.assertEqual(args[:3], ['docker', 'ps', '--all'])
            return ''
        host = ci.Host(Path('.'), config, run=run)
        host.stop()
        self.assertEqual(len(calls), 1)
        self.assertTrue(hasattr(host, 'stop_time'))

    def test_docker_daemon_failure_cannot_be_mistaken_for_stopped_bot(self):
        config = json.loads(Path(__file__).with_name('ci-host-config.example.json').read_text())
        config['database_host'] = 'synthetic.aivencloud.com'
        def run(args, **kwargs): raise RuntimeError('Docker unavailable')
        host = ci.Host(Path('.'), config, run=run)
        with self.assertRaises(RuntimeError): host.stop()

    def test_worker_and_polling_errors_on_stderr_are_included_in_log_gate(self):
        result = type('Result', (), {'returncode': 0, 'stdout': 'worker started\n',
                                     'stderr': 'PROCESSING recovery failed.\n'})()
        with patch.object(ci.subprocess, 'run', return_value=result):
            logs = ci.command(['docker', 'logs', 'synthetic-container'])
        self.assertIn('PROCESSING recovery failed.', logs)

    def test_boot_recovery_stops_candidate_and_checks_zero_owner_before_rollback(self):
        calls = []
        class RecoveryHost:
            request = REQUEST
            def __init__(self, folder, config): pass
            def load_recovery(self): calls.append('load-protected-context')
            def stop(self): calls.append('stop')
            def quiescent(self): calls.append('zero-owner')
            def start(self, old): self_outer.assertTrue(old); calls.append('start-old')
            def verify(self, old): self_outer.assertTrue(old); calls.append('verify-old')
            def journal(self, pending): self_outer.assertFalse(pending); calls.append('clear-journal')
        self_outer = self
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'pending.json').write_text(json.dumps({'pending': True, 'folder': str(root / '123-1')}))
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'trusted', lambda p, **kw: Path(p)), \
                    patch.object(ci, 'Host', RecoveryHost), patch.object(ci, 'write_json'):
                ci.recover({})
        self.assertEqual(calls, ['load-protected-context', 'stop', 'zero-owner', 'start-old', 'verify-old', 'clear-journal'])

    @unittest.skipUnless(sys.platform == 'linux', 'Linux host lock semantics')
    def test_host_lock_excludes_a_second_deployment_and_releases(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(ci, 'ROOT', Path(temp)):
            with ci.deployment_lock():
                with self.assertRaises(BlockingIOError):
                    with ci.deployment_lock(): self.fail('Concurrent deployment lock acquired')
            with ci.deployment_lock(): pass

    @unittest.skipUnless(sys.platform == 'linux', 'Linux fsync/permission semantics')
    def test_journal_write_is_private_atomic_and_durable(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'state.json'
            ci.write_json(file, {'pending': True})
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            ci.write_json(file, {'pending': False})
            self.assertEqual(json.loads(file.read_text()), {'pending': False})
            self.assertFalse(file.with_suffix('.json.tmp').exists())


if __name__ == '__main__':
    unittest.main()
