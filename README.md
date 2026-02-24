# Azure Codex Chat — VS Code Extension

A GitHub Copilot-style AI coding assistant powered by **Azure OpenAI GPT-5.2 Codex Max**, built as a native VS Code sidebar extension.

---

## ✨ Features

- **Chat sidebar** — persistent conversation panel in the VS Code activity bar
- **Streaming responses** — tokens appear in real-time as the model generates
- **Code actions** — right-click any selected code to: Explain, Fix, or Generate
- **Insert to editor** — one-click to insert generated code directly into your file
- **Context-aware** — knows the active file's language for better completions
- **Multi-turn memory** — maintains conversation history (last 20 messages)
- **Fully themeable** — adapts to your VS Code color theme (light/dark)

---

## 🚀 Setup

### 1. Install dependencies & compile

\`\`\`bash
npm install
npm run compile
\`\`\`

### 2. Configure Azure OpenAI

Open VS Code Settings (`Ctrl+,`) and search for **Azure Codex**:

> Tip: The endpoint can be either `https://{resource}.openai.azure.com/` or `https://{resource}.cognitiveservices.azure.com/`.

| Setting | Description | Example |
|---|---|---|
| `azureCodex.endpoint` | Your Azure OpenAI resource URL | `https://my-resource.openai.azure.com/` |
| `azureCodex.apiKey` | Your Azure API key | `abc123...` |
| `azureCodex.deploymentName` | Your deployment name | `gpt-5-2-codex-max` |
| `azureCodex.apiVersion` | Legacy Chat Completions `api-version` (the extension uses the Responses API automatically for GPT‑5/Codex deployments) | `2025-04-01-preview` |
| `azureCodex.maxTokens` | Max output tokens per response | `4096` |
| `azureCodex.temperature` | Creativity (0–1, lower = more precise) | `0.2` |

### 3. Run / Debug the extension

Press `F5` in VS Code to open an **Extension Development Host** window with the extension loaded.

### 4. Package as .vsix

\`\`\`bash
npm run package
\`\`\`

Install the `.vsix` in VS Code via: `Extensions → ... → Install from VSIX`

---

## 🎮 Usage

### Chat Panel
Click the **Azure Codex icon** in the activity bar (left sidebar) to open the chat.

By default, the extension includes a small amount of **workspace context** (file list + active file + README/package.json when present) so the model can answer questions like “summarize this project” without you pasting files.

Use the **Context** button to view what’s being sent, and the **+** button to pin additional files/images into context.

### Stop generation
Use the **Stop** button (square icon) while the assistant is streaming to cancel the current request.

### Applying File Changes
When the assistant wants to create/update files, it will respond with code blocks like:

```file
path: src/example.ts
// full file contents...
```

Click **Apply** on the code block header to write the file into your workspace. For deletions, it will use:

```delete
path: src/oldFile.ts
```

### Context Menu (Right-click in Editor)
Select any code and right-click for:
- **Azure Codex: Explain Selected Code**
- **Azure Codex: Fix Selected Code**
- **Azure Codex: Generate Code from Comment**

### Commands (`Ctrl+Shift+P`)
- `Azure Codex: Open Chat`
- `Azure Codex: Clear Chat History`
- `Azure Codex: Generate Code from Comment`

---

## 🗂 Project Structure

\`\`\`
azure-codex-extension/
├── src/
│   ├── extension.ts        # Extension entry point, command registration
│   ├── azureClient.ts      # Azure OpenAI API client (streaming)
│   ├── chatViewProvider.ts # Webview sidebar provider
│   └── chatHTML.ts         # Chat UI (HTML/CSS/JS)
├── media/
│   └── icon.svg            # Activity bar icon
├── package.json            # Extension manifest
└── tsconfig.json
\`\`\`

---

## 🔧 How It Works

1. The extension registers a **WebviewView** in VS Code's activity bar sidebar
2. User messages are sent from the webview → `extension.ts` → `azureClient.ts`
3. The Azure OpenAI client calls your endpoint with **streaming enabled**
4. Tokens stream back in real-time and are rendered with markdown/code formatting
5. Chat history (last 20 turns) is maintained in memory for multi-turn context

---

## 🔐 Security Note

Your API key is stored in VS Code's settings file. For production use, consider using VS Code's `SecretStorage` API (`context.secrets`) to store the key securely instead of plain settings.
