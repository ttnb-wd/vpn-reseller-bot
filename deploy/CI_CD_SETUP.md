# Prepared Metro VPN CI/CD — inactive

The workflow is deliberately named `.github/workflows/metro-production.yml.disabled`.
GitHub does not activate it. Nothing in this document is an instruction to apply
production changes without the initial activation approval.

## Prepared behavior

Push to `main`: secret scan of source and Git history, lint, isolated Linux tests,
build on a standard GitHub-hosted Linux runner, provider-free image smoke, GHCR
publication, digest-only SSH request, on-host health checks and automatic image
rollback. Pull requests run verification only. No `pull_request_target` job exists.

The original 25 staging paths remain included. The editor cleanup, complete unit
suite and CI/CD files expand the exact manifest; use the new generated manifest
under `.migration-validation/`, not `git add .` or the old 25-path list alone.
All 104 previously excluded operational deployment files remain excluded.

The workflow serializes runs and never cancels an in-flight deployment. The
receiver also holds a Linux file lock. It pulls the exact GHCR digest before
stopping anything, verifies platform/revision/source labels, the unchanged schema
contract, complete environment and rollback availability. It then stops the old
container, verifies no matching bot process and zero database singleton owners,
and recreates only service `bot`, with `--no-build --pull never --no-deps`.

The trusted receiver uses the existing root-owned Compose configuration and raw
environment file; it accepts no new Compose file, environment, shell command,
script or arbitrary registry from GitHub. Docker images are never built on the
VPS. The application retains its existing 192 MiB cap, 96 MiB heap, zero swap,
loopback binding, non-root user, read-only filesystem, dropped capabilities,
Watchtower exclusion, CPU/PID limits and seven-session database budget.

Rollback retains the previous local image with a unique tag, saved full runtime
configuration, protected environment and CA copies, and a durable recovery journal.
It stops the candidate and verifies zero owners before starting the previous image.
It never restores a database, invokes migrations, or changes Outline, Caddy, Render,
firewall, payments, VPN keys or subscription settings. A system service owns the
operation independently of SSH; OnFailure and boot recovery retry pending rollback.
If Docker, Aiven, the lease check or rollback image is unavailable, recovery fails
closed rather than starting an overlapping bot. This can require operator attention.

## Current one-time setup status

The approved VPS bootstrap is installed and verified: root-owned receiver, pinned
runtime copy, restricted deployment account/key, argument-free sudo, and enabled
boot/OnFailure recovery. The empty-journal recovery canary and botless read-only
TLS/role/singleton preflight passed without replacing or restarting production.
Dedicated SSH reaches only the receiver; requested shell commands are substituted
by it, and invalid JSON requests fail. A root-owned public-key directory needed an
explicit searchable mode after the private installation umask filtered its mode.

GitHub environment `production` permits only `main`, with no required reviewers.
The two SSH secrets and host variable below are configured; default workflow token
permissions remain read-only. Both repository activation variables are **false**,
the workflow filename remains disabled, and no Git changes have been staged/pushed.
The GHCR package does not yet exist: publication and an anonymous VPS digest pull
must pass before production deployment can be enabled.

## One-time setup checklist

1. Integration inspection is complete within the accessible accounts. Installed
   GitHub Apps are CodeRabbit, Continue, Cursor, Render and Vercel. Both accessible
   Vercel workspaces returned no project for this repository. Repository webhooks,
   Actions workflows, deployment records and self-hosted runners were empty at audit.
   No deployment cron/timer/runner was detected on the VPS, and the bot opts out of
   Watchtower. Render's existing legacy forwarder is live, tracks its separate legacy
   branch, and has Auto-Deploy **Off**. Leave it unchanged. Recheck integration state
   immediately before the first approved push; app installations and permissions
   can change independently of repository files.
2. Protect `main` from unauthorized writers/force pushes. Review changes to CI,
   the receiver, Dockerfile and runtime configuration explicitly. Ordinary approved
   application changes can deploy automatically; the root-owned receiver itself
   is never updated from a push. Keep `production` restricted to the `main` branch
   with **no required human reviewers** for the requested future automatic workflow.
3. Use this public repository and standard `ubuntu-24.04` GitHub runners. Create
   the GHCR package linked to this repository, restrict its write access, and make
   its **secret-free image** public for anonymous VPS pulls. No registry PAT is
   required on the VPS. Do not enable paid runners, private-package billing or
   additional services. Keep spending budgets at zero. Public runner billing and
   package visibility rules are documented below.
4. On explicit initial approval, install the reviewed receiver as
   `/usr/local/libexec/metro-ci-deploy.py`, owned by root, mode `0755`. Copy the host
   config template to `/etc/metro-vpn/ci.json`, root mode `0600`, replacing the
   active existing Compose pathname, its verified SHA-256 and current Aiven hostname.
   Privately confirm that this exact Compose file reproduces the existing live
   container's complete resolved configuration before pinning it. Runtime template
   changes then fail before stopping the bot until separately reviewed and re-pinned. Do not
   put a database URL, password or Telegram token in this file. The active Compose
   file and secret environment file must be root-owned, mode `0600`, under root-owned
   directories not writable by the deployment account.
5. Install `ci-recover.service` as `/etc/systemd/system/metro-ci-recover.service`,
   root mode `0644`. Validate it with `systemd-analyze verify`, reload systemd unit
   metadata, and enable its boot recovery after approval. This does not require
   restarting Docker, SSH, Caddy, Outline, or the production bot.
6. Create dedicated account `metro-deploy`, with locked password, no Docker group,
   no unrestricted sudo and no other authorized keys. Use a newly generated SSH
   key dedicated to this repository; never reuse the operator's root SSH key.
   Retain a functioning shell for the forced command, but prohibit interactive use.
   Root must own and protect the key file and its parent directory from that account.

   Exact forced-key restriction (replace the public-key placeholder privately):

   ```text
   restrict,command="sudo -n -- /usr/local/libexec/metro-ci-deploy.py" ssh-ed25519 PUBLIC_KEY_PLACEHOLDER
   ```

   Exact sudoers entry, validated with `visudo -cf` before installing:

   ```text
   metro-deploy ALL=(root) NOPASSWD: /usr/local/libexec/metro-ci-deploy.py ""
   ```

   The empty argument expression permits only argument-free invocation. The
   SSH substitutes the receiver for requested remote commands; those commands do
   not execute. The receiver accepts bounded, schema-checked JSON stdin.
   Its Python isolated mode prevents imports from the login user's working directory.
7. Create GitHub Environment **production** and configure these names securely:

   | Kind | Name | Purpose |
   | --- | --- | --- |
   | Environment secret | `METRO_SSH_KEY` | Dedicated forced-command private key |
   | Environment secret | `METRO_KNOWN_HOSTS` | Existing independently verified SSH host key entry |
   | Environment variable | `METRO_SSH_HOST` | Existing VPS SSH host |
   | Repository variable | `METRO_PUBLISH_ENABLED` | Initially `true` only for the first image publication |
   | Repository variable | `METRO_DEPLOY_ENABLED` | Keep `false` until host/bootstrap/rollback gates pass |

   Do not store `DATABASE_URL`, Aiven credentials, Telegram token, Outline credentials,
   payment secrets, dynamic token secrets or admin/session secrets in GitHub.
   They stay in the existing protected VPS environment. Use the job's short-lived
   `GITHUB_TOKEN` for image publication; it has `packages:write` only in that job.
   SSH uses strict host verification, with no `ssh-keyscan` trust shortcut, agent
   forwarding, PTY, port forwarding, or general remote shell.
8. Review the new exact staging manifest and commit/push only after approval.
   The disabled filename can safely be published as preparation without starting CI.
   Activation requires a separately approved rename to `metro-production.yml`.
   First enable publication with deployment still disabled. Verify package
   visibility and anonymous digest pull, the installed receiver checksum, sudoers,
   systemd unit, host memory/disk gates, rollback image and preserved runtime config.
   Then set `METRO_DEPLOY_ENABLED=true` and perform one supervised initial deployment.
   After it passes, future ordinary `main` pushes require no manual deployment approval.

## Validation boundaries

The test job receives no production secrets. It uses a clean environment, disables
dotenv, blocks external sockets and runs inside `--network none` without Docker
socket access. Five real-PostgreSQL integration tests intentionally skip without a
disposable test URL. This pipeline does not claim those tests run against Aiven.
The application role is checked read-only during deployment and the schema
contract must stay unchanged; schema changes require a separate migration workflow.

The image smoke runs with the 192 MiB cap but does not launch a real bot. It checks
all 47 runtime hashes, no unexpected runtime files, no `.env`, and the seven-session
budget. Actual bot memory/worker/HTTPS checks occur only during an approved deployment.
The receiver observes readiness, polling ownership, process count, restart/OOM count,
memory events, admin authentication redirect/CSP, Mini App page, worker-start signals,
unchanged runtime restrictions and unrelated containers for over a worker interval.
No real passwords, purchases, approvals, key creation or customer messages are used.

Local fault injection verifies replacement ordering, preflight failures, missing
containers after partial Compose failure, failed starts/health checks and blocked
singleton rollback. Live forced SSH/sudo and the empty-journal transient recovery
canary have now passed. Live GHCR publication/pull, an actual reboot with pending
recovery, and a real production replacement remain untested until the relevant
approved activation step.
Chrome's deceptive-site classification is a separate unresolved issue; HTTPS health
checks do not prove the hostname is cleared by Safe Browsing.

## References

- [GitHub concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
- [Pinned action security](https://github.com/github/docs/blob/main/content/actions/reference/security/secure-use.md)
- [Container registry digest and authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Public package anonymous access](https://docs.github.com/en/enterprise-cloud@latest/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
- [Public standard-runner billing](https://docs.github.com/en/actions/concepts/billing-and-usage)
- [Public packages and Container registry billing](https://docs.github.com/en/enterprise-cloud@latest/billing/concepts/product-billing/github-packages)
