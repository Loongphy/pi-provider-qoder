# pi-provider-qoder

让 [pi](https://pi.dev/) 接入 **Qoder API** 的 provider 扩展，通过 Qoder 全球站与 Qoder 中国站提供模型。

## 功能

> [!NOTE]
> `qoder`（国际版）不做主动维护，只定期同步上游；本仓库的改动集中在 `qoder-cn`（中国版）。
> 上游修复以**手工移植**方式引入（不 merge、不搬目录结构），详见「上游同步」。

- **双 provider 入口**：`qoder`（全球站）与 `qoder-cn`（中国站，强制走 CN 端点，独立于 `QODER_REGION`）。
- **登录**：全球站支持浏览器设备码登录或 Personal Access Token（PAT）；中国站走独立 PAT 登录（`/login qoder-cn`）。PAT 会被兑换为短期 job token，过期后自动重新兑换。
- **动态模型列表**：从上游 `/model/list` 拉取并缓存模型、上下文、推理档位等配置，picker 直接显示上游 `display_name`，型号重命名/升级后自动跟随，无需维护映射表。
- **推理等级回传**：把 pi 的 thinking level 映射为 Qoder 的 `reasoning_effort` + `enable_thinking` 一并发送，picker 显示的档位与上游实际支持的保持一致。关闭思考时按 qodercli 的方式同时发三个信号（`enable_thinking:false` + `reasoning_effort:"none"` + `is_reasoning:false`），只发前者时网关仍会按推理模型路由；目录明确没有 disabled 档的模型（发 `"none"` 会 400）则只关不加。
- **输出上限 128K**：对齐阿里云百炼官方 Max Output Length（131072），思考模式下不截断思维链。
- **上下文自适应**：从 `context_config` 取最大可选档（如 1M），目录无配置时回退 1M。
- **签名与 WAF 绕过**：内置 COSY 签名头生成（RSA/AES-CBC/MD5）与 WAF body 编码（`Encode=1`）。COSY 客户端身份自动跟随最新 qodercli 发布版本（24h 缓存、只升不降、取不到时用随包兜底版本），旧身份会让模型端点返回缩水列表。
- **排队等待与状态行**：上游模型饱和时（10605 通知）自动进入队列：优先轮询 `/queue/status`，slot 空出后才重发整段对话；等待期间在编辑器上方渲染一条专属状态行（`Queued on … · position N · est. wait … · check again in Ns`），每秒更新、单行截断，不占用 pi 的 working row（`Working for …`），也不写 stderr 污染 TUI。
- **按任务计费的请求身份**：同一次用户提问的所有 tool round-trip 共享 `request_set_id` 与 `business.id`（对齐 qodercli 的 AgentLifecycle），网关据此把一个任务累计成一笔计费，而不是每个请求各计一次。
- **provider 契约兼容**：自动识别 pi-ai 交给 provider 的三种上下文形态——≥0.86 折叠过的 `TranscriptContext`、≤0.85 的扁平 `Context`、以及导出了 transcript helper 但仍传扁平 `Context` 的宿主（如 OMP）——不会把 system prompt 与 tools 解析成空值而静默丢掉整个工具调用协议。
- **工具调用协议加固**：不符合 Qoder wire 格式（`^[a-zA-Z0-9_-]{1,64}$`）的内部 id（pi 的 Responses 适配层会产出 `call_x|fc_x`）只在发往上游时改写为确定性摘要，本地历史不动，assistant 的 `tool_calls` 与对应 `tool` 结果始终配对；参数 JSON 不完整或非法时报错终止本轮，不再退化成 `{}` 把工具执行一遍。
- **流式收尾**：`[DONE]`（裸 `data:` 与信封 `body:"[DONE]"` 两种形态）立即结束读取并释放连接；出错的轮次同样释放，不会留下一个没人读的 response body。
- **思考内容带外回放**：assistant 的 reasoning 用 `reasoning_content` 字段回传，不再折叠进可见正文（否则模型会在下一轮自问自答）；同时清理网关偶发泄漏进 reasoning 的 DSML 工具调用标记，若一轮既无正文又无工具调用则按可重试的服务端错误上报，而不是当成正常结束把任务悄悄丢掉。
- **图像工具结果连续**：一次 `tool_calls` 的多条结果先全部回完，再统一附一条带标签的 `user` 消息携带图片；逐条插入会打断 tool run，上游会以 `insufficient tool messages following tool_calls message` 拒绝。
- **启动与热路径开销**：模型列表刷新不阻塞 pi 启动与会话开始；WAF body 编码单趟查表、直出 Buffer（实测 5MB body 原先约 400ms 的主线程阻塞，现在快 6–18 倍，逐字节等价由测试钉住）；COSY 的 MD5 单趟链式计算；`auth.json` 与模型缓存在进程内 memoize；上游的细粒度 delta 合并后再交给 pi 渲染。

## 安装

**安装本项目（fork，含本文档所述改动）：**

```bash
pi install github:Loongphy/pi-provider-qoder
```

**安装上游项目：**

```bash
pi install npm:pi-provider-qoder
```

安装后在 pi 中登录：

```text
/login qoder        # 全球站
/login qoder-cn     # 中国站
```

也可用环境变量免交互登录：

```bash
export QODER_PERSONAL_ACCESS_TOKEN=pt-...      # 全球站
export QODERCN_PERSONAL_ACCESS_TOKEN=pt-...    # 中国站
```

## 使用

登录后在 pi 里选模型：

```text
/model Qwen3.8-Max
```

或直接启动（`Model.id` 就是上游 `display_name` 去掉空格，匹配不区分大小写）：

```bash
pi --provider qoder-cn --model Qwen3.8-Max
```

### 排队状态与日志

- 队列状态显示在编辑器上方的专属 widget 行（与 `Working for …` 各占一行，互不覆盖），排队结束自动移除。
- 插件日志默认只在 stderr **不是终端**（管道/文件）时输出；终端场景下写 stderr 会破坏 pi 的 TUI（差异渲染的行坐标会被打乱，表现为状态行/输入框上方不断堆积变动文本）。需要临时观察排队日志时：

```bash
QODER_LOG=1 pi ...          # 强制开启（会弄花 TUI，建议重定向到文件）
pi ... 2> qoder.log         # 或直接重定向 stderr，天然安全
```

`QODER_QUEUE_LOG` 是 `QODER_LOG` 的别名。其余可调环境变量：

| 变量 | 作用 |
| --- | --- |
| `QODER_QUEUE_POLL` | 排队时是否轮询 `/queue/status`（默认开启；关闭则按通知里的等待时长重发） |
| `QODER_MODEL_QUEUE_MAX_WAIT_MS` | 排队等待的总预算（默认 3600000，即 1 小时） |
| `QODER_QUEUE_YIELD_GRACE_MS` | 状态行先让位给宿主 widget（如状态栏扩展）的宽限时间，默认 1200ms、上限 10s |
| `QODER_STREAM_FLUSH_MS` | delta 合并窗口（默认 40ms，上限 1000ms） |
| `QODER_LOG` / `QODER_QUEUE_LOG` | 强制开/关插件日志（`0`/`1`） |
| `QODER_DEBUG` | 额外输出被跳过的畸形 SSE 行等调试信息 |
| `PI_AGENT_DIR` | 排队状态/握手文件的目录（默认 `~/.pi/agent`）。模型缓存与 COSY 版本缓存不受它影响，始终写在 `$HOME/.pi/agent` |

## 支持的模型

模型列表由上游 `/model/list` 动态返回，插件不做映射；下表是当前 Qoder CN 目录的实际内容（取自模型缓存，`上下文` 为 `context_config` 的最大可选档，`计费系数` 为目录的 `price_factor`，仅供相对比较）。

| 显示名 (`Model.id`) | 上游 key | 上下文 | 推理 | 图像 | 计费系数 | 推理档位 |
| --- | --- | --- | :---: | :---: | :---: | --- |
| Auto | `auto` | 200K | ✅ | ✅ | 0.5 | — |
| Qwen3.8-Max | `qmodel_38max` | 1M | ✅ | ✅ | 0.5 | low / medium / xhigh |
| Qwen3.8-Flash | `qfmodel` | 1M | ✅ | ✅ | 0 | low / medium / xhigh |
| Qwen3.7-Max | `qmodel_latest` | 1M | ✅ | ✅ | 0.5 | toggle（开/关） |
| Qwen3.7-Plus | `qmodel` | 1M | ✅ | ✅ | 0.1 | toggle（开/关） |
| Qwen3.7-Flash | `q37fmodel` | 1M | ✅ | ✅ | 0.1 | — |
| DeepSeek-V4-Pro | `dmodel` | 1M | ✅ | ✅ | 0.5 | high / max |
| DeepSeek-Flash | `dfmodel` | 1M | ❌ | ✅ | 0.1 | low / high / max |
| GLM-5.3 | `gmodel` | 1M | ✅ | ✅ | 0.8 | low / high / max |
| GLM-5.3-Flash | `gfmodel` | 1M | ✅ | ✅ | 0.1 | high / max |
| GLM-5.2 | `gm51model` | 1M | ✅ | ✅ | 0.6 | high / max |
| Kimi-K3 | `kmodel_latest` | 1M | ❌ | ✅ | 1.4 | low / high / max |
| Kimi-K2.8-Preview | `kmodel` | 1M | ✅ | ✅ | 0.8 | low / high / max |
| MiniMax-M2.7 | `mmodel` | 200K | ❌ | ❌ | 0.2 | — |

> `推理` 取目录的 `is_reasoning`；`推理档位` 来自 `thinking_config`：effort 模型可指定等级，toggle 模型只能开/关，标 `—` 的模型目录没有给出 `thinking_config`（个别模型 `is_reasoning` 与档位字段互相矛盾，以上游为准，插件不擅自补全）。上游新增/改名模型后会自动跟随，无需改动本插件。

## 上游同步

上游 <https://github.com/simonsmh/pi-provider-qoder> 的重构（`src/protocol/` 分包、固定区域绑定、friendly model id）与本仓库的扁平目录不兼容，因此**不做 merge**：上游的正确性修复被逐条移植进本仓库的实现，移植时保留本仓库自有的排队轮询、任务级计费身份与状态行。

已移植（对应上游提交/PR）：

| 上游 | 内容 |
| --- | --- |
| #13 `1e44cde` | 目录未给配置时的上下文回退值改为 1M |
| #24 `fda9a04` | 支持的 thinking 等级补 `max` |
| #25 `b1715c5` + #38 `f061e1f` | provider 上下文契约兼容（TranscriptContext / 扁平 Context / 无 system 消息的 transcript） |
| #23 `03fd968` | WAF body 编码直出 Buffer |
| — `8a2a9b2` | 热路径：COSY MD5 单趟、`auth.json` 与模型缓存进程内 memoize |
| — `1eee024` + #35 `e12f381` + #36 `d51ee0f` | COSY 客户端身份动态跟随最新 qodercli，签模型目录前先刷新 |
| — `bd3d020` + — `a238e42` | 向 pi 全局注册 `qoder-api`（`streamSimple`），并以运行时探测兼容 OMP |
| #28 `d276ec0` | 清理泄漏的 DSML 标记，退化轮次上报为可重试错误 |
| #29 `d1688a0` | reasoning 走 `reasoning_content` 带外回放 |
| #30 `2bacd5b` | 图像工具结果与 tool run 保持连续 |
| #33 `5aa5503` | 改写不符合 wire 格式的工具调用 ID |
| #39 `ed5f18e` | （部分）参数非法/截断时报错而非以 `{}` 执行；按 ID 归并参数暂未移植 |
| #40 `255e07e` + `030a1fb` | 关闭思考时发全三信号；无 disabled 档的模型不发 `reasoning_effort:"none"` |
| — `e4c55f4` | `[DONE]` 结束读取并释放连接；丢弃被跳过轮次的孤儿工具结果 |
| #41 `4e13648` | 10605 "假排队"（`isQueued:false`）重试——本仓库的排队路径已覆盖，无需重复移植 |

未采用的上游能力：Credits/余额展示（`credits.ts`/`quota.ts`/`credit-footer.ts`）、`src/protocol/` 分包与固定区域重构、Fast 模型支持（走动态目录，无需改代码）。

## License

MIT
