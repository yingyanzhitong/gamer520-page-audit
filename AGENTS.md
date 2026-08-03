# Gamer520 项目规则

## 生产发布流程

当用户明确要求“发布”“部署生产环境”或“提交并发布”时，按以下流程执行；不要只完成本地构建就宣称已上线。

1. 确认本次变更范围，仅保留与需求直接相关的文件；若工作区混有无关改动，停止并请用户确认。
2. 在发布提交前更新以下文件：
   - `package.json` 的 SemVer 补丁版本；
   - `package-lock.json` 顶层和根包版本；
   - `CHANGELOG.md`，使用简体中文记录日期、变更和用户影响。
3. 执行 `npm ci --ignore-scripts`、`npm run check`、`npm test` 和 `git diff --check`。任何检查失败都不得创建标签或触发部署。
4. `npm run build` 会将前端产物生成到 `public/`；将新的哈希资源、`public/index.html` 和被替换的旧资源一起纳入提交。
5. 仅显式暂存已确认的发布文件，检查暂存区后提交。发布提交必须位于 `main`，并先执行 `git push origin main`。
6. 确认 `package.json` 版本为 `<version>`、远端不存在同名标签后，创建并推送带注释的标签：

   ```bash
   git tag -a "v<version>" -m "v<version>"
   git push origin "v<version>"
   ```

7. 标签会触发 `.github/workflows/build-deploy.yml`：构建 `linux/amd64` 镜像并推送 GHCR，再通过受限 SSH 在服务器部署。使用 `gh run watch <run-id> --exit-status` 等待结束；只有 `success` 才表示部署完成。
8. 发布后必须执行独立验收：
   - `https://gamer520.xyyamsz.cn/healthz` 返回 HTTP 200；
   - 生产首页返回 HTTP 200，并引用本次构建生成的新哈希前端资源；
   - 使用真实浏览器检查公开登录页能正常加载。需要管理员会话的功能，只有在获得用户授权并具备有效登录态后才能在线操作验证。
9. 若工作流失败、服务器报告正在运行任务、容器不健康或公网验收失败，停止发布流程；不得绕过锁、强制重启任务或手工替代部署。报告失败步骤、日志链接和仍未确认的影响。
10. 最终报告必须包含：提交 SHA、版本标签、GitHub Actions 链接、线上健康检查结果和浏览器验收结论。不要在代码、日志、提交信息或报告中暴露部署密钥、Token、Cookie、密码或数据库内容。
