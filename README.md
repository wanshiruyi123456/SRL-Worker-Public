# SRL-Worker-Public

可由使用者自行部署的 Cloudflare Worker，为 SillyTavern Resource Library Public 提供设备码中继、加密暂存和 Koofr WebDAV 中继。此仓库不托管 SRL 网页，不包含官方账号、登录、资源广场、反馈或官方更新服务。

## 部署

需要 Node.js 22 或更新版本、pnpm 11 和自己的 Cloudflare 账号。

```powershell
pnpm install --frozen-lockfile
pnpm exec wrangler login
Copy-Item wrangler.example.jsonc wrangler.jsonc
pnpm deploy
```

`wrangler.jsonc` 会被 Git 忽略。首次部署会创建 `BridgeSession` Durable Object 所需的 SQLite 类；不要把账号信息、Token 或个人绑定配置提交到仓库。

部署后，在 SRL Public 的“设置 → 自部署 Worker”填写 Cloudflare 返回的 Worker HTTPS 根地址，例如 `https://your-worker.workers.dev`。这个地址保存在当前浏览器或 APK 的本机设置中。无需设备码中继和 Koofr 代理时可留空。

## 提供的接口

- `/api/bridge/*`：酒馆设备码中继与加密暂存。中继内容由端到端加密或应用层令牌保护；Worker 只暂存加密分块及必要的短期会话状态。
- `/api/cloud/health`：Koofr 代理健康检查。
- `/api/cloud/proxy/koofr?url=...`：仅允许转发到 `https://app.koofr.net/dav/Koofr/` 下的 WebDAV 地址。请求凭据由用户自己的浏览器发送至其 Worker，再转发给 Koofr；Worker 不持久化这些凭据。

浏览器调用使用不带 Cookie 的 CORS 请求。CORS 只允许常规网页、Capacitor、Ionic 与 Tauri 来源，不构成用户身份验证；请只在自己的 Cloudflare 账号部署，并妥善保管 Koofr 凭据。

## 本地检查

```powershell
pnpm test
pnpm exec wrangler deploy --dry-run --config wrangler.example.jsonc
```

源码许可与上游来源见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
