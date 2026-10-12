# Neon Bridge · 让 AI 住进你的 Minecraft（Forge 1.20.1）

> Node 端跑 LLM 思考闭环，Forge 客户端 mod 只当「手脚」——
> AI 玩的就是**你自己那个游戏客户端**，因此能和任何 mod、任何整合包共存。

---

## 这是什么

一个**每一步都由 LLM 当场决定**的 Minecraft 智能体。

它不是「关键词触发 + 预设动作」的脚本：每一轮都真实调用大模型去
**观察 → 理解处境 → 形成意图 → 决定一个具体动作 → 执行 → 看结果 → 更新记忆与目标 → 继续**。
代码里**没有**「检测到 X 就做 Y」的规则，**没有**静态动作清单让模型勾选，**没有**失败后的硬编码兜底动作。

它也不是「外挂」：不做内存修改、不做封包伪造、不加速、不透视。
它就是一个**替你敲键盘的普通玩家**——只不过敲键盘的是 AI。

---

## 和 mineflayer 系方案的区别

|  | mineflayer 系 | **本项目** |
|---|---|---|
| 怎么进游戏 | 自己实现协议，冒充客户端 | 你开游戏，mod 在里面当手脚 |
| 能进 mod 服 / 整合包 | ❌ 内容 mod 会让它崩 | ✅ 只要是 Forge 客户端就行 |
| 需要第二个正版账号 | 通常需要 | ❌ 不需要 |
| 单人世界 | 必须开 LAN | ✅ 直接就能用 |
| 服务器端检测 | 是独立客户端 | 就是你本人的客户端 |

代价是：你**必须开着游戏**，AI 才能动。

---

## 工作原理

```
        你（在 MC 里聊天 / 看它干活）
                 ↕
   ┌─────────────────────────────────────┐
   │  Forge 客户端 + neonbridge mod      │  ← 手脚：采集状态 + 执行原语
   └─────────────────────────────────────┘
                 ↕  TCP 127.0.0.1:8765，换行分隔 JSON
   ┌─────────────────────────────────────┐
   │  Node AI 进程（bot.js）             │  ← 大脑：L0~L5 LLM 闭环
   └─────────────────────────────────────┘
                 ↕  HTTPS
   ┌─────────────────────────────────────┐
   │  任意 OpenAI 兼容的 LLM 端点        │
   └─────────────────────────────────────┘
```

**职责严格分离**：mod 端只做「真实客户端 API 调用」，**不做任何决策**；一切决策来自 Node 端的 LLM。

### 每一轮 = 一条真实的思考链（5~6 次 LLM 调用，无缓存、无预设）

| 层 | 作用 | 输入 → 输出 |
|---|---|---|
| **L0 记忆检索** | 挑出相关历史 | 处境 + 记忆目录 → `{relevant:[id]}` |
| **L1 处境理解** | 理解「现在怎么了」 | 完整观察 → 一段自然语言 |
| **L2 意图层** | 想要什么 + 需要哪类动作 | L1 输出 → `{intent, types:[...]}` |
| **L3 机械筛选** | **只按 type 过滤原语** | 纯代码，无 LLM、无语义映射 |
| **L4 决策层** | 选一个具体原语 | 子集 + 意图 → 自然语言决策 |
| **落地** | 自然语言 → 可执行调用 | `lib/intent.js`：LLM 语义解析 + 机械类型校验 |
| **执行** | 动手 | `lib/primitives.js`（HTTP 之上是 mod） |
| **L5 反思层** | 评估结果 + 更新记忆 + 评估目标 | 结果 + 目标 → `{assessment, episodic, semantic, goalDecision}` |

`L2` 决定「需要哪几类能力」→ `L3` 只把对应类型的原语子集交给 `L4`，
所以模型**从来不会看到一张完整的动作清单**。

### 自我修正

- 同一动作**连续失败 3 次** → 写入语义记忆，并在下一轮观察里明确提示「不要再重复它，换一种完全不同的做法」。
- 落地失败（参数不对 / 原语不存在）→ 把**失败原因喂回 L4 重决**，而不是偷偷换一个硬编码动作。

---

## 目录结构

```
fadaowangshang/
├─ ai/                     Node 端（大脑）
│  ├─ bot.js               入口：连桥、装配闭环、终端对话、优雅退出
│  ├─ config.js            只放「环境变量 + 非敏感参数 + 身份文本」，无行为规则
│  ├─ lib/
│  │  ├─ llm.js            LLM 通信（多端点 fallback + 退避 + JSON 容错解析）
│  │  ├─ observe.js        观察生成（分层自然语言，不是 JSON 堆叠）
│  │  ├─ memory.js         三层记忆 + 落盘脱敏 + 写入节流
│  │  ├─ goals.js          目标系统（存储 + 状态迁移）
│  │  ├─ primitives.js     原语层（按类型分组的底层单步操作）
│  │  ├─ intent.js         意图解析（LLM 语义落地 + 类型校验）
│  │  ├─ loop.js           闭环调度（L0→L5）
│  │  ├─ bridge.js         与 mod 的 TCP 桥（含心跳探活）
│  │  └─ log.js            日志（脱敏 + 级别过滤）
│  ├─ examples/smoke.js    冒烟测试：起一个「假 mod」，不需要真游戏
│  ├─ data/                运行数据（记忆）；`.gitkeep` 占位，内容不入库
│  └─ .env.example         环境变量模板
├─ mod/                    Forge 1.20.1 客户端 mod（手脚）
│  └─ src/main/java/com/neon/bridge/
│     ├─ NeonBridge.java   入口
│     ├─ BridgeServer.java TCP 服务端（listen 8765）
│     ├─ StateCollector.java  状态采集
│     └─ ActionExecutor.java  原语执行
├─ PROTOCOL.md              Node ⟷ mod 通信协议
└─ LICENSE                 MIT
```

---

## 快速开始

**前置**：JDK 17+、一个 Forge 1.20.1 客户端、Node.js 18+。

### 1) 构建 mod

```bash
cd mod
./gradlew build          # Windows: gradlew.bat build
# 产物：mod/build/libs/neonbridge-1.0.0.jar
```

### 2) 装上 mod

把上面那个 jar 放进客户端的 `mods/` 目录，启动游戏。
mod 会在 `127.0.0.1:8765` 监听（仅本机，不对外）。

### 3) 配置 Node 端

```bash
cd ai
npm install
cp .env.example .env     # Windows: copy .env.example .env
```

编辑 `.env`，**至少**填一个 LLM 端点：

```ini
LLM_PRIMARY_BASE_URL=https://api.deepseek.com/v1
LLM_PRIMARY_API_KEY=你的Key
LLM_PRIMARY_MODEL=deepseek-chat
MASTER_NAME=你的游戏ID
```

> `LLM_PRIMARY_*` 是**主端点**，`LLM_FALLBACK_*` 是**备用端点**（主端点 429 / 报错时自动兜底）。
> 两者都可以填任何 OpenAI 兼容的 `/chat/completions` 服务。
> （历史命名 `AGNES_*` / `AMD_*` 仍被识别，但已不推荐。）

### 4) 启动

```bash
node bot.js
```

终端会打印连接状态。进入游戏世界后，AI 就开始自主行动了。

- **终端直接打字** = 以 `MASTER_NAME` 的身份对 AI 说话
- **MC 里的聊天**会回显到终端（`[聊天]` 前缀）

---

## 配置项

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `LLM_PRIMARY_BASE_URL` | ✅ | — | 主 LLM 端点基址 |
| `LLM_PRIMARY_API_KEY` | ✅ | — | 主 LLM 密钥 |
| `LLM_PRIMARY_MODEL` | ⬜ | `deepseek-chat` | 主端点模型名 |
| `LLM_FALLBACK_BASE_URL` / `LLM_FALLBACK_API_KEY` / `LLM_FALLBACK_MODEL` | ⬜ | — | 备用端点；主端点 429/报错时自动兜底 |
| `BRIDGE_HOST` / `BRIDGE_PORT` | ⬜ | `127.0.0.1` / `8765` | 桥地址，需与 mod 一致 |
| `BRIDGE_PING_INTERVAL_MS` | ⬜ | `10000` | 主动心跳间隔 |
| `BRIDGE_IDLE_TIMEOUT_MS` | ⬜ | `25000` | 多久收不到任何来包就判定连接已死（半开连接检测） |
| `MASTER_NAME` | ⬜ | `player` | 你的游戏 ID：AI 靠它判断「谁是自己人」 |
| `SELF_NAME` | ⬜ | — | 期望的 AI 角色名 |
| `MEMORY_FILE` | ⬜ | `./data/memory.json` | 记忆持久化路径 |
| `MEMORY_SAVE_THROTTLE_MS` | ⬜ | `2000` | 记忆落盘节流；`0` = 立即写 |
| `LOOP_STEP_DELAY_MS` | ⬜ | `1200` | 每轮之间的间隔 |
| `ACTION_TIMEOUT_MS` | ⬜ | `45000` | 单个动作等待 mod 回执的上限 |
| `OBSERVE_RADIUS` | ⬜ | `16` | 观察半径 |
| `SHORT_TERM_LEN` | ⬜ | `12` | 短期记忆条数 |
| `STATE_STALE_MS` | ⬜ | `6000` | 状态多久算过期 |
| `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` | ⬜ | `0.85` / `900` | 采样参数 |
| `LLM_TIMEOUT` / `LLM_RETRIES` | ⬜ | `30000` / `2` | 单次超时与重试 |
| `LLM_MIN_GAP_MS` | ⬜ | `1500` | 两次 LLM 调用之间的最小间隔（限速） |
| `LLM_EXTRA_BODY` | ⬜ | — | 额外请求体（JSON 字符串），如 `{"chat_template_kwargs":{"thinking":false}}` |
| `LLM_REASONING_FALLBACK` | ⬜ | `false` | 是否允许把 `reasoning_content` 当正文兜底（默认丢弃） |
| `LOG_LEVEL` | ⬜ | `info` | `error` / `warn` / `info` / `verbose` / `debug` |

---

## 冒烟测试（不需要真游戏）

```bash
cd ai
node examples/smoke.js
```

它会起一个**假 mod**（TCP 8765，推送 mock 状态、回执所有动作），然后拉起 `bot.js`，
用于验证「观察 → 决策 → 落地 → 执行 → 反思」整条链路是否通。仍需 `.env` 里有可用的 LLM Key。

---

## 已知限制

- **附魔**：mineflayer / 高层封装在 1.20.1 上对附魔台窗口交互不可靠，该原语会**如实返回失败并说明原因**，
  而不是假装成功（遵循「做不到就说做不到」的原则）。其余原语均已实现。
- **版本**：方块 / 物品 / 实体名按 **1.20.1** 命名（如 `oak_log`、`grass_block`、`crafting_table`）。
- **必须开着游戏**：mod 跑在客户端里，游戏关了 AI 就没有身体。
- **LLM 成本**：每轮 5~6 次调用。把 `LOOP_STEP_DELAY_MS` 调大能省钱，也能让行为更像人。

---

## 安全与隐私

- **密钥只走环境变量**：代码里没有任何明文 Key。`config.js` 里的 `apiKey` 被定义为**不可枚举属性**，
  `JSON.stringify(cfg)` / `console.log(cfg)` 都不会把它带出去。
- **`.env`、`data/`、日志** 全部在 `.gitignore` 里，不会被提交。
- **日志脱敏**：`lib/log.js` 的 `scrub()` 会把密钥、令牌、邮箱、含用户名的绝对路径替换成 `***`，
  所以你贴日志求助时不会顺手泄漏。
- **记忆脱敏**：`memory.json` 是「玩家聊天 + 模型输出」的混合体，落盘前同样会过一遍 `scrub()`。
- **网络暴露面**：mod 只监听 `127.0.0.1:8765`，不对外；只有本机的 Node 进程能连。
- ⚠️ **`data/memory.json` 含真实对话记录，请不要提交、不要分享。**

---

## 许可

MIT，见 [LICENSE](LICENSE)。

`mod/` 使用 Forge MDK 脚手架，其中 `mod/LICENSE.txt`、`mod/CREDITS.txt`、`mod/changelog.txt`
是 Forge 项目的原始文件，版权归其作者所有。
