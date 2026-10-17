"""Provider-free invariants; actionlint performs the separate full YAML lint."""
import ast
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
prepared = root / '.github/workflows/metro-production.yml.disabled'
active = root / '.github/workflows/metro-production.yml'
workflow = (prepared if prepared.exists() else active).read_text()
assert not (prepared.exists() and active.exists()), 'Two workflow copies are forbidden'
assert 'cancel-in-progress: false' in workflow
assert 'runs-on: ubuntu-24.04' in workflow and 'self-hosted' not in workflow
assert 'pull_request_target:' not in workflow
assert all(re.fullmatch(r'[a-f0-9]{40}', sha) for sha in re.findall(r'uses: [\w/-]+@([^\s]+)', workflow))
assert workflow.count('persist-credentials: false') == 3
assert 'packages: write' not in workflow.split('  publish:')[0]
assert 'secrets.METRO_SSH_KEY' not in workflow.split('  deploy:')[0]
assert '--network none' in workflow and '--ignore-scripts' in workflow
assert 'vars.METRO_PUBLISH_ENABLED' in workflow and 'vars.METRO_DEPLOY_ENABLED' in workflow
assert 'environment: production' in workflow
assert 'prisma migrations prisma.config.ts' in workflow
assert not re.search(r'secrets\.(?:DATABASE|AIVEN|BOT_TOKEN|OUTLINE)', workflow)
assert 'docker build' in workflow.split('  publish:')[1].split('  deploy:')[0]
for source in ('deploy/ci-deploy.py', 'deploy/ci-deploy.test.py', 'ci/ssh-deploy.py'):
    ast.parse((root / source).read_text())
tools = json.loads((root / 'ci/tools.json').read_text())
assert re.search(r'@sha256:[a-f0-9]{64}$', tools['node'])
assert all(re.fullmatch(r'[a-f0-9]{64}', value) for key, value in tools.items() if key.endswith('Sha256'))
print('Pipeline safety invariants: PASS')
