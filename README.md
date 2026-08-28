# pi-provider-qoder

让 [pi](https://pi.dev/) 接入 **Qoder API** 的 provider 扩展，通过 Qoder 全球站与 Qoder 中国站提供模型。

## 功能

> [!NOTE]
> `qoder`（国际版）不做主动维护，只定期同步上游；本仓库的改动集中在 `qoder-cn`（中国版）。

- **双 provider 入口**：`qoder`（全球站）与 `qoder-cn`（中国站，强制走 CN 端点，独立于 `QODER_REGION`）。
- **登录**：全球站支持浏览器设备码登录或 Personal Access Token（PAT）；中国站走独立 PAT 登录（`/login qoder-cn`）。PAT 会被兑换为短期 job token，过期后自动重新兑换。
- **动态模型列表**：从上游 `/model/list` 拉取并缓存模型、上下文、推理档位等配置，picker 直接显示上游 `display_name`，型号重命名/升级后自动跟随，无需维护映射表。
- **推理等级回传**：把 pi 的 thinking level 映射为 Qoder 的 `reasoning_effort` + `enable_thinking` 一并发送，picker 显示的档位与上游实际支持的保持一致。
- **输出上限 128K**：对齐阿里云百炼官方 Max Output Length（131072），思考模式下不截断思维链。
- **上下文自适应**：从 `context_config` 取最大可选档（如 1M），无配置时回退 200K。
- **签名与 WAF 绕过**：内置 COSY 签名头生成（RSA/AES-CBC/MD5）与 WAF body 编码（`Encode=1`）。

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
/model qwen3.8-max
```

或直接启动：

```bash
pi --provider qoder-cn --model qwen3.8-max
```

## 支持的模型

模型列表由上游动态返回，以下为当前 Qoder CN 实际提供的模型：

| 显示名 (`Model.id`) | 上游 key | 上下文 | 推理 | 图像 | 免费 | 推理档位 |
| --- | --- | --- | :---: | :---: | :---: | --- |
| Qwen3.8-Max | `qmodel_38max` | 1M | ✅ | ✅ | ✅ | off / low / medium / xhigh |
| Qwen3.8-Flash | `qfmodel` | 1M | ✅ | ✅ | ✅ | off / low / medium / xhigh |
| Qwen3.7-Max | `qmodel_latest` | 1M | ✅ | ✅ | ✅ | toggle（开/关） |
| Qwen3.7-Plus | `qmodel` | 1M | ✅ | ✅ | ✅ | toggle（开/关） |
| Qwen3.7-Flash | `q37fmodel` | 1M | ✅ | ✅ | ✅ | toggle（开/关） |

> 上下文为 `context_config` 中的最大可选档；推理档位来自上游 `thinking_config`，effort 模型可选具体等级，toggle 模型只能开关。上游新增/改名模型后会自动跟随，无需改动本插件。

## License

MIT
