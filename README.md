# qoder2api

## 文件结构

```
cloudflare/
├── wrangler.toml          # Workers 配置（KV 可选）
├── src/
│   ├── index.js           # Worker 入口：路由/鉴权/CORS/流式输出
│   ├── qoder.js           # 上游客户端：凭证/jobToken/刷新/COSY/签名请求/SSE 解析
│   ├── login.js           # 设备码登录（PKCE S256 + 轮询），Worker 内原生实现
│   ├── crypto.js          # WebCrypto AES + BigInt RSA PKCS#1 v1.5
│   └── wasm/
│       ├── glue.js        # 从 runtime bundle 剥离的 wasm-bindgen glue
│       └── wasm-b64.js    # 内嵌签名 WASM（base64）
├── dist/_worker.js        # 单文件构建（Pages 高级模式 / Dashboard 粘贴用）
├── build-single.mjs       # 单文件构建脚本
├── test/node-e2e.mjs      # Node 直跑 Worker handler 的端到端测试（打真实网关）
└── package.json
```

## 部署

### 方式一：Workers（wrangler，推荐）

```bash
cd cloudflare
npx wrangler login
npx wrangler deploy
# → https://qoder2api.<你的子域>.workers.dev/v1
```

### 方式二：Pages（单文件，无需 wrangler）

```bash
cd cloudflare && node build-single.mjs
# 把 dist/_worker.js 放进任意发布目录（或新建 Pages 项目 → 直接上传该文件所在目录）
# Pages 项目设置里无需其它配置；Custom domain 按需绑定
```

### 方式三：Dashboard 在线粘贴

Workers → Create Worker → 编辑器粘贴 `dist/_worker.js` 全文 → Deploy。

## 配置凭证

四种方式（解析优先级：KV > `QODER_CREDS_JSON` > 单独 secrets）：

**A. Worker 内直接登录（推荐，全程无需本地脚本）**

绑定 QODER_KV 后两条命令完成，浏览器授权在自己设备上进行：

```bash
npx wrangler kv namespace create QODER_KV     # 把输出的 id 填进 wrangler.toml
npx wrangler secret put API_KEY               # 自定义访问密钥
npx wrangler deploy

# 1) 发起登录, 拿到 login_url
curl -X POST https://<worker>/admin/login -H "Authorization: Bearer <API_KEY>"
# → {"nonce":"…","login_url":"https://qoder.cn/users/sign-in?biz_variant=qoder&oauth_callback=…",…}

# 2) 用手机/浏览器打开 login_url, 登录并确认绑定账号, 然后:
curl -X POST https://<worker>/admin/login/wait \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"nonce":"<上一步的nonce>"}'
# → {"ok":true,"token":"dt-xxxx…","user":{…}}   凭证已自动写入 KV
```

说明：轮询与官方一致（1s 间隔 / 300s 超时，404=未授权继续）；`wait` 可重复调用
（客户端超时后重试安全，会话在 KV 里保留 10 分钟直至成功或过期）。

**B. KV + 上传现成 creds.json**

```bash
curl -X POST https://<worker>/admin/creds \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  --data-binary @../creds.json                # 整个 creds.json 原样上传
```

**C. Secret 直接放 creds.json 内容**

```bash
npx wrangler secret put QODER_CREDS_JSON      # 粘贴 creds.json 全文
```

**D. 单独 secrets**：`QODER_DEVICE_TOKEN`、`QODER_REFRESH_TOKEN`、
`QODER_USER_ID`、`QODER_USER_NAME`、`QODER_USER_EMAIL`（COSY 凭证需要 userinfo，
方式 D 需补齐）、可选 `QODER_MACHINE_ID`。

> `userinfo`（id/name/email）参与 COSY 用户凭证加密，必须存在；
> 方式 A 登录时自动拉取，方式 B/C 的 `creds.json`（由 `node qoder-login.mjs` 生成）已包含。

## API

`base_url = https://<worker域名>/v1`，鉴权：配置了 `API_KEY` 时所有请求带
`Authorization: Bearer <API_KEY>`（含 `/admin/*`）。

| 路由 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容，`stream: true/false`；错误走 OpenAI error 格式，Credits 用尽返回 402 |
| `GET /v1/models` | 14 个模型 key |
| `GET /health` | 存活检查 |
| `POST /admin/login` | 发起设备码登录，返回 `login_url` + `nonce`（需 QODER_KV） |
| `POST /admin/login/wait` | 长轮询 `{nonce, timeout?}` 到授权完成，凭证自动写入 KV |
| `POST /admin/creds` | 写入/更新 KV 凭证 |
| `DELETE /admin/creds` | 清除 KV 凭证与 jobToken（切换账号用） |
| `POST /admin/refresh` | 手动刷新 deviceToken（KV 存在时落盘） |
| `GET /admin/status` | 凭证状态（token 脱敏、jobToken 过期时间、KV 绑定情况） |

**思考深度**：请求体传 `reasoning_effort`（或 `reasoning: {"effort": …}`），
档位 `none / low / medium / high / xhigh / max`（`minimal`→low、`off`→none 自动映射）。
流式思考走 `delta.reasoning_content`（DeepSeek 风格），非流式在 `message.reasoning_content`。

```bash
curl https://<worker>/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"qfmodel","stream":true,"reasoning_effort":"high",
       "messages":[{"role":"user","content":"9.11 和 9.9 哪个大？"}]}'
```

模型 key 与本地版一致：`qfmodel`(Qwen3.8-Flash 免费档) / `gmodel`(GLM-5.3) /
`dmodel`(DeepSeek-V4-Pro) / `kmodel`(Kimi) / `mmodel`(MiniMax-M3) / `cmodel`(Cantus) /
`auto` / `lite` 等，详见 `GET /v1/models`。

## 客户端接入

任何 OpenAI SDK 把 base_url 指到 Worker 即可：

```python
from openai import OpenAI
client = OpenAI(base_url="https://qoder2api.<子域>.workers.dev/v1", api_key="<API_KEY>")
print(client.chat.completions.create(model="qfmodel",
      messages=[{"role": "user", "content": "你好"}]).choices[0].message.content)
```

## 本地开发与测试

```bash
cd cloudflare
npx wrangler dev                 # 本地 workerd 跑 Worker（凭证用 secret/vars 注入）
node test/node-e2e.mjs           # Node 直跑 handler 打真实网关（15 项断言）
node ../_parity-test.mjs         # 剥离 glue 与原 lib 签名产物一致性 + 网关直测
```

## 升级与再生成

IDE 升级导致签名 WASM 变化时：

```bash
node deobf.mjs && node _build-cf-wasm.js   # 重新剥离 → 重新生成 cloudflare/src/wasm/
node _parity-test.mjs                      # 验证后再部署
```

## 注意事项

- **CPU 限制**：免费计划单请求 10ms CPU。SSE 解析是纯字符串处理，一般够用；
  高并发/长文本建议 $5 Workers Paid（无 CPU 焦虑）。
- **refresh_token 一次性**：自动刷新由模块级单飞（single-flight）保护，
  不会并发轮换导致作废；刷新结果只在绑定了 KV 时持久化，否则 30 天后需重新登录。
- **凭证安全**：`QODER_CREDS_JSON`/`API_KEY` 用 `wrangler secret put`（加密存储），
  不要写进 `wrangler.toml` 的 `[vars]`；`/admin/*` 在配置了 `API_KEY` 时强制鉴权。
- **上游限制**：网关按账户计费/限流，429/402 原样透传；machine_id 建议固定
  （默认用 creds.json 里的），频繁变化可能触发风控。
