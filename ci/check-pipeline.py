"""Provider-free invariants; Render's deployment gate is configured separately."""
import ast
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
workflow = (root / '.github/workflows/metro-production.yml').read_text()
assert 'cancel-in-progress: false' in workflow
assert 'runs-on: ubuntu-24.04' in workflow and 'self-hosted' not in workflow
assert 'pull_request_target:' not in workflow
assert all(re.fullmatch(r'[a-f0-9]{40}', sha) for sha in re.findall(r'uses: [\w/-]+@([^\s]+)', workflow))
assert workflow.count('persist-credentials: false') == 2
assert 'permissions:\n  contents: read' in workflow
assert not re.search(r'\b(?:packages|contents): write', workflow)
assert not re.search(r'secrets\.|METRO_DEPLOY_ENABLED|METRO_PUBLISH_ENABLED|ssh-deploy|ci-deploy.py|deployHook', workflow)
assert '--network none' in workflow and '--ignore-scripts' in workflow
assert 'prisma migrations prisma.config.ts' in workflow
assert '  render-candidate:\n    needs: verify' in workflow
assert 'docker build --platform linux/amd64' in workflow
assert 'node ci/image-smoke.cjs' in workflow
assert not re.search(r'^  (?:deploy|publish):', workflow, re.M)
assert 'files.length !== 40' in (root / 'ci/run-tests.cjs').read_text()
assert len(json.loads((root / 'deploy/runtime-files.json').read_text())) == 49
for source in ('deploy/ci-deploy.py', 'deploy/ci-deploy.test.py', 'ci/ssh-deploy.py'):
    ast.parse((root / source).read_text())
tools = json.loads((root / 'ci/tools.json').read_text())
assert re.search(r'@sha256:[a-f0-9]{64}$', tools['node'])
assert all(re.fullmatch(r'[a-f0-9]{64}', value) for key, value in tools.items() if key.endswith('Sha256'))
print('Render CI safety invariants: PASS; no production deploy action in workflow')
