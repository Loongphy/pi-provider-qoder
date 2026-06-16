# pi-provider-qoder

A [pi](https://shittycodingagent.ai/) provider extension that connects pi to the **Qoder API**, exposing Qoder models through one provider surface.

## Features

- **Interactive Login**: Standard OAuth browser device-code flow or Personal Access Token (PAT) login.
- **WAF Bypass**: Built-in WAF obfuscation and body encoding (`Encode=1`).
- **COSY Signing**: Full COSY signature header generation (RSA/AES-CBC/MD5).
- **Dynamic Model Catalog**: Dynamically fetches model limits, effort configurations, and options from the `/algo/api/v2/model/list` endpoint.
- **Reasoning/Thinking Support**: Real-time extraction of thinking process from API reasoning or HTML-like `<think>` tags.

## Quick start

Install the provider:

```bash
pi install npm:pi-provider-qoder
```

Or install it globally with npm:

```bash
npm install -g pi-provider-qoder
```

Then log in from pi:

```text
/login qoder
```

The login flow will prompt you to complete authorization in your browser.

### Personal Access Token (PAT) Fallback

For non-interactive environments, you can set the `QODER_PERSONAL_ACCESS_TOKEN` (or `QODER_PAT`) environment variable before starting pi. The provider will automatically pick up the PAT and authenticate.

## Models

Exposes the following backing models:

- **Tier Tiers**: `auto`, `ultimate`, `performance`, `efficient`, `lite`
- **Frontier Models**:
  - `qmodel` (Qwen3.7 Plus)
  - `qmodel_latest` (Qwen3.7 Max)
  - `dmodel` (DeepSeek V4 Pro)
  - `dfmodel` (DeepSeek V4 Flash)
  - `gm51model` (GLM 5.1)
  - `kmodel` (Kimi K2.6)
  - `mmodel` (MiniMax M3)

## Usage

Once logged in, select any Qoder model in pi:

```text
/model ultimate
```

Or let Qoder select automatically:

```text
/model auto
```

## Architecture

```
src/
├── index.ts            # Extension registration
├── cosy.ts             # COSY Signature and Machine ID resolver
├── login.ts            # OAuth Device Flow login sequence
├── login-ui.ts         # Custom TUI components for login
├── models.ts           # Model definitions and Dynamic Config Cache
├── oauth.ts            # PAT / OAuth callback orchestrator
├── stream.ts           # Main streaming response handler
├── transform.ts        # Message conversions (OpenAI schema mapping)
├── thinking-parser.ts  # Fallback <think> tag parser
└── qoder-encoding.ts   # WAF bypass body encoder
```

## License

MIT
