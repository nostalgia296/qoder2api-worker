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
| `POST /v1/chat/completions` | OpenAI 兼容（含工具调用），`stream: true/false`；错误走 OpenAI error 格式，Credits 用尽返回 402 |
| `GET /v1/models` | 14 个模型 key |
| `GET /health` | 存活检查 |
| `POST /admin/login` | 发起设备码登录，返回 `login_url` + `nonce`（需 QODER_KV） |
| `POST /admin/login/wait` | 长轮询 `{nonce, timeout?}` 到授权完成，凭证自动写入 KV |
| `POST /admin/checkin` | 领取全部可领活动（每日 100 credits），幂等 (需 API_KEY) |
| `GET /admin/campaigns` | 活动/签到状态列表 (需 API_KEY) |
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

**工具调用**：网关原生支持 OpenAI function calling，代理逐字段透传（实测验证）：

- `tools`：`[{type:'function', function:{name, description, parameters, strict?}}]`
- `tool_choice` / `parallel_tool_calls` / `response_format`：进上游 `parameters` 对象
  （官方 wire 格式；`auto` 实测生效，`required` 上游不强制）
- `messages` 多轮原生透传：`system` / `user` / `assistant`（含 `tool_calls`）/
  `tool`（含 `tool_call_id`）四个角色，`developer` 自动映射为 `system`
- 流式：`delta.tool_calls` 分片原样转发，结束块 `finish_reason: 'tool_calls'`；
  `stream_options: {"include_usage": true}` 时追加独立 usage 块
- 非流式：`message.tool_calls`（按 `index` 合并分片后的完整调用）

**usage 透传**：上游在 finish 事件之后单独下发一个 usage 事件，代理捕获后回填——
非流式响应的 `usage` 为上游真实值；流式时真实 usage 挂在 finish 块上（无论客户端是否
声明 `include_usage`），声明了则额外追加一个 `choices: []` 的独立 usage 块（OpenAI 规范）。
字段为 OpenAI 标准 + Qoder 扩展：

```json
{"prompt_tokens":65, "completion_tokens":210, "total_tokens":275,
 "prompt_tokens_details":{"cached_tokens":0},
 "completion_tokens_details":{"reasoning_tokens":183},
 "credits":0.01375418, "original_credits":0.01375418, "billable":false}
```

`credits`/`original_credits` 是本次请求消耗的账户额度，`billable` 表示是否计费。

**每日签到/活动领 Credits**（对应逆向文档 CHAT_FLOW.md 第十节，`campaignMainService`）：

```bash
curl -X POST https://<worker>/admin/checkin -H "Authorization: Bearer <API_KEY>"
# → {"ok":true,"granted":100,"claimed":1,"results":[{"campaignKey":"act-…","status":"GRANTED",
#     "benefit":{"kind":"CREDITS","amount":100}}],"campaigns":[…全部活动…]}
#   重复领取: status 仍 GRANTED 但 replayed=true / granted=0
#   被风控拦截: failureCode=SAME_PERSON_ALREADY_CLAIMED (按人/设备指纹每日一次)
```

- `POST /admin/checkin` 领取所有 `CLAIM_BENEFIT` 且 `CLAIMABLE` 的活动；
  `GET /admin/campaigns` 只查状态不领取
- **自动签到**：wrangler.toml 里取消 `[triggers] crons` 注释（默认北京时间 09:16）并绑定
  QODER_KV，Worker 每天自动领取并把结果写入 KV；`vars AUTO_CHECKIN = "false"` 可只停签到
- `/admin/status` 的 `last_checkin` 字段可查最近一次（手动或 cron）签到结果
- deviceToken 过期时签到接口会自动走 refresh 流程（与对话链路共用）

```bash
curl https://<worker>/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"qfmodel",
       "messages":[{"role":"user","content":"北京天气怎么样？"}],
       "tools":[{"type":"function","function":{"name":"get_weather",
         "description":"查询城市实时天气",
         "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}'
# → choices[0].finish_reason = "tool_calls"
#   choices[0].message.tool_calls[0].function = {"name":"get_weather","arguments":"{\"city\": \"北京\"}"}
```

把 `tool` 角色结果（`role:'tool'`, `tool_call_id`, `content`）追加进 messages 再请求
即完成一轮工具回合。注意 qfmodel 属 flash 档，个别情况下会把 tool 结果回传后再调一次
工具（模型随机性，重试即可）；Credits 模型（GLM/DeepSeek/Kimi 等）工具调用更稳定。

**图片识别（视觉）**：OpenAI `image_url` 内容部件透传，支持 data URL（base64）与
http(s) 图片地址，与 IDE 发送截图的方式一致（`is_vl` 模型，qfmodel/qmodel 已验证）：

```bash
curl https://<worker>/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"qfmodel",
       "messages":[{"role":"user","content":[
         {"type":"text","text":"这张图片是什么颜色？"},
         {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}]}'
```

- `detail`（`high`/`low`/`auto`）跟随透传；`input_audio:{data,format}` 部件同样支持
- 请自行选择支持视觉的模型；图片建议压缩后发送（base64 直接进签名请求体，越大越慢）

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