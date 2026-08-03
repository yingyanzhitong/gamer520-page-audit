#!/usr/bin/env bash
set -Eeuo pipefail

read -r -a command_parts <<< "${SSH_ORIGINAL_COMMAND:-}"
if [[
  "${#command_parts[@]}" -ne 3 ||
  "${command_parts[0]}" != "deploy" ||
  ! "${command_parts[1]}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ||
  ! "${command_parts[2]}" =~ ^[A-Za-z0-9_-]+$
]]; then
  echo "拒绝未授权的部署命令" >&2
  exit 64
fi

image_tag="${command_parts[1]}"
github_actor="${command_parts[2]}"
ghcr_token="$(cat)"
if [[ -z "${ghcr_token}" ]]; then
  echo "缺少 GHCR 临时令牌" >&2
  exit 65
fi

deploy_dir="/home/ma/gamer520-page-audit"
container_name="gamer520-page-audit-crawler-1"
image_name="ghcr.io/yingyanzhitong/gamer520-page-audit"

exec 9>"${deploy_dir}/.github-actions-deploy.lock"
if ! flock -n 9; then
  echo "已有 Gamer520 部署正在执行" >&2
  exit 75
fi

cd "${deploy_dir}"
xianyu_api_key="$(sed -n 's/^XIANYU_API_KEY=//p' .env | head -n 1)"
if [[ -n "${xianyu_api_key}" ]]; then
  schedule="$(
    curl -fsS \
      -H "X-API-Key: ${xianyu_api_key}" \
      http://127.0.0.1:13520/api/settings/schedule
  )"
  if [[
    "$(jq -r '.crawl.active // false' <<< "${schedule}")" == "true" ||
    "$(jq -r '.sync.active // false' <<< "${schedule}")" == "true"
  ]]; then
    echo "检测到 Gamer520 任务正在运行，自动部署已取消" >&2
    exit 76
  fi
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_name="gamer520-before-${image_tag}-${timestamp}.sqlite"
if docker inspect "${container_name}" >/dev/null 2>&1; then
  docker exec \
    -e BACKUP_NAME="${backup_name}" \
    "${container_name}" \
    node -e '
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync("/app/data/gamer520.sqlite");
      database.prepare("VACUUM INTO ?").run(`/app/data/${process.env.BACKUP_NAME}`);
      database.close();
    '
  docker cp \
    "${container_name}:/app/data/${backup_name}" \
    "${deploy_dir}/backups/${backup_name}" >/dev/null
fi

printf '%s' "${ghcr_token}" |
  docker login ghcr.io -u "${github_actor}" --password-stdin >/dev/null
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

if grep -q '^IMAGE_NAME=' .env; then
  sed -i "s#^IMAGE_NAME=.*#IMAGE_NAME=${image_name}#" .env
else
  printf '\nIMAGE_NAME=%s\n' "${image_name}" >> .env
fi
if grep -q '^IMAGE_TAG=' .env; then
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${image_tag}/" .env
else
  printf 'IMAGE_TAG=%s\n' "${image_tag}" >> .env
fi

docker compose pull crawler
docker compose up -d --no-deps --force-recreate crawler

for _ in $(seq 1 60); do
  health="$(
    docker inspect "${container_name}" \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
  )"
  [[ "${health}" == "healthy" ]] && break
  sleep 2
done
if [[ "${health}" != "healthy" ]]; then
  docker logs --tail 100 "${container_name}" >&2
  exit 1
fi

deployed_version="$(
  docker exec "${container_name}" \
    node -p 'require("/app/package.json").version'
)"
if [[ "${deployed_version}" != "${image_tag}" ]]; then
  echo "容器版本 ${deployed_version} 与目标版本 ${image_tag} 不一致" >&2
  exit 1
fi
curl -fsS http://127.0.0.1:13520/healthz >/dev/null
curl -fsS https://gamer520.xyyamsz.cn/healthz >/dev/null
docker image prune -a -f >/dev/null || echo "警告：未引用镜像清理失败" >&2
echo "Gamer520 ${image_tag} 部署成功，备份：${backup_name}"
