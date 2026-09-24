import { execFileSync } from 'node:child_process';

/**
 * The container boundary proof is deliberately a single Bash program: the trap
 * must remove the starter container even when a readiness or HTTP assertion
 * fails. Keeping it here leaves the workflow responsible only for image build
 * and runner selection.
 */
export function containerSmokeScript(): string {
  return String.raw`set -euo pipefail
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --cpus 1 --pids-limit 128 \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m,uid=1000,gid=1000,mode=700 \
  --entrypoint sh urlcode:test -ec '
    node /opt/urlcode/dist/cli.js recipes add typescript --out /tmp/source
    node /opt/urlcode/dist/cli.js build-typescript --project /tmp/source --out /tmp/built
    node /opt/urlcode/dist/cli.js validate --project /tmp/built
  '
docker run -d --name urlcode -p 127.0.0.1:3000:3000 -v "$PWD/starters/default:/project:ro" urlcode:test
trap 'docker logs urlcode; docker rm -f urlcode' EXIT
for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3000/_urlcode/ready; then break; fi
  sleep 1
done
test "$(curl --silent -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/missing)" = 404
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --cpus 1 --pids-limit 128 \
  -v "$PWD/examples/assets:/project:ro" urlcode:test test`;
}

export function runContainerSmoke(): void {
  execFileSync('bash', ['-euo', 'pipefail', '-c', containerSmokeScript()], { stdio: 'inherit' });
}

if (import.meta.main) runContainerSmoke();
