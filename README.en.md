# Chat Bubble

[简体中文](README.md) | **English**

ChatBubble is a transparent floating chat app for Windows, with a small slime companion on your desktop. Drag it to an edge, click it to open the chat input, and click outside to collapse it. It supports streaming replies, saved drafts, conversation history, manual screenshots, compatible chat APIs, and native Codex CLI conversations.

Current release: **0.16.1**. **The app interface is currently in Chinese.** This English README helps you download, configure, and use it; it does not change the app's interface language.

## Download and run

1. Open [GitHub Releases](https://github.com/SeXon007/ChatBubble/releases/latest) and download `ChatBubble-0.16.1-win32-x64.zip`.
2. Extract the complete folder. Keep all its files together.
3. If an older instance is running, right-click its system tray icon and select **退出** (Exit).
4. Run `ChatBubble.exe` from the extracted folder.

This is an unsigned Windows x64 portable test release. You do not need Node.js to run the downloaded app. Codex CLI mode requires Codex CLI to be installed and signed in on that computer; API mode requires your provider's API key. Model access, quotas, and charges depend on your account.

Existing users on 0.14.2 or later can check for updates in **设置 → 版本** (Settings → Version). Versions 0.13.x have no updater, and 0.14.1 has a download issue; update those versions manually. Updates prepare a separate version folder and preserve the previous folder and configured chat storage.

## First-time setup

Right-click the **system tray icon** and select **设置** (Settings). Right-clicking the slime triggers its interactions instead of opening settings.

| App label | Meaning | What it controls |
| --- | --- | --- |
| 连接 | Connection | API or Codex CLI, provider, model, and connection check |
| 聊天 | Chat | Message area height, screenshot scope, storage, and history |
| 外观 | Appearance | Text size, color, and shadow |
| 桌宠 | Desktop pet | Slime appearance and movement parameters |
| 版本 | Version | Current version and GitHub update controls |

For **API** mode, choose DeepSeek, Kimi, Zhipu GLM, or a custom service. A preset fills in the service address. Enter its API key and select or type a model ID. Custom services must support the Chat Completions streaming protocol; a complete `/chat/completions` URL is also accepted. Model suggestions do not guarantee that your account has access. Claude CLI is no longer available.

For **Codex CLI** mode, install the CLI and sign in with `codex login` first. The app can detect common installation paths or accept a manually selected executable. You can choose or type a model and reasoning effort. Leaving the model blank uses the CLI default; the app does not claim that a cached model list proves account access.

Changes save automatically. Dropdowns and switches save immediately; text saves after a short pause or when focus leaves the field. API keys are encrypted using the existing system-backed credential store and bound to the service address. Switching addresses does not forward the old key to the new service. Only one address-bound key is stored at a time.

**检查连接** (Check connection) sends a short test request without your chat history and may use account quota. Opening settings does not automatically send this test.

## Slime and chat controls

- **Left-click the slime:** it smoothly stretches into the chat input. Click another app or press **Esc** to collapse it back to its previous position. Drafts and ongoing replies are retained.
- **Left-drag:** move the slime. Release near any screen edge to let it settle and spread against that edge.
- **Right-click and release:** the slime hops away and rebounds on landing.
- **Hold and drag the right mouse button:** stretch the slime around its current anchor; release to let it spring back.
- **Since 0.16.1:** the established soft spring motion remains enabled even when Windows animation effects are disabled. You do not need to change Windows settings. Existing pet parameters are preserved.
- **Enter:** send. **Shift+Enter:** insert a line break. Input method composition does not submit a message.
- During a reply, the send button becomes a stop button. An incomplete answer can be retried using its original user message.
- Click the tray icon to show or hide the companion. The tray menu provides **开始新对话** (New conversation), **设置** (Settings), and **退出** (Exit).

The message area height is adjustable from 120 to 800 px, with a default of 380 px, subject to screen space. The input bar stays 42 px high and scrolls internally for longer text. Transparent empty areas allow mouse input to pass through to other apps.

## Manual screenshots

The screenshot button next to Send is available with Codex CLI and supported vision API models. **Screenshots are taken only when you click this button.** Opening the chat, dragging the slime, or sending ordinary text does not capture the screen.

In **设置 → 聊天 → 截图范围** (Settings → Chat → Screenshot scope), select **前台窗口** (Foreground window, the default) or **整个屏幕** (Entire screen). Entire screen captures the display containing the cursor, including visible windows and the taskbar; it does not stitch multiple monitors together.

Successful captures are copied to the clipboard and attached to the next message. Click the screenshot button again to retake or detach the image. Detaching does not delete the saved file. A clipboard error leaves the saved attachment available to send. Failed captures do not silently reuse an earlier image. Pending images survive collapsing the chat but are not restored after restarting the app.

Images retain their original PNG resolution for storage, clipboard, and model input. Limits remain 16 MB per image and 16 million pixels for native capture. API requests allow up to 8 images and 24 MB of original image data in total. Retries reuse the original image; eligible images from successful conversation history may accompany later questions within the budget, increasing image input usage.

The app uses Windows capture exclusion to omit its own slime, messages, input bar, and settings without hiding them or changing focus. Full exclusion requires Windows 10 version 2004 or newer and also affects other capture tools that honor that Windows mechanism. Other hardware, capture software, remote desktop, and display configurations may behave differently.

Official API models with unconfirmed vision support have screenshots disabled. Custom APIs can attempt standard `image_url` input; compatibility depends on the service. Changing the provider, model, screenshot scope, or conversation clears the pending attachment association. ChatBubble does not display inline images or thumbnails in the chat.

## Storage, history, and privacy

For new users, the program folder's `chat/` directory holds `state.json` for settings, drafts, and the current conversation; `sessions/` for archived conversations; and `attachments/` for saved screenshots. Saved images are not automatically deleted. Removing a referenced image can prevent later viewing or retrying it.

Existing configured chat locations continue to be used. Settings can copy the chat data to an empty folder and switch storage only after verification; the original is retained. The storage location pointer, encrypted credentials, and CLI working directory remain in `%APPDATA%\ChatBubble`. Do not distribute your user data directory with a release. Windows credential encryption does not protect against every program running under the same signed-in user.

History is separated by Codex CLI, DeepSeek, Kimi, Zhipu, and each custom API address. Switching sources archives the current conversation and draft before starting an empty conversation; changing models within the same source keeps the conversation. Older records with uncertain origins are retained locally as unclassified rather than mixed into another source.

Codex CLI mode uses native App Server conversations and saves their thread IDs for continuation after restart. Completed messages added through the Codex desktop app can be read back. If another app holds the conversation, close it there before retrying. Simultaneous generation, external edits or rollbacks, and automatic sharing between computers, Windows/WSL, or different `CODEX_HOME` directories are not supported.

ChatBubble restricts its Codex connection to read-only chat, disables tools, plugins, memory, and configured MCP integrations through startup overrides, and does not change the global CLI configuration. Screenshots go to your selected model service when sent. The app does not provide automatic computer control, tool calls, voice, or parallel conversations.

## Development and verification

Use Node.js 22.23 or a newer supported version.

```powershell
npm ci
npm start
npm test
npm run smoke
npm run test:restart
npm run package
```

Build output goes to `dist/`; portable packages go to `release/`. Packaging refuses to overwrite an existing version folder. Electron may download its runtime on first use. If downloads require an HTTP proxy, you can set `$env:NODE_USE_ENV_PROXY='1'` in that PowerShell session.

Automated smoke and restart checks use isolated data and local fixtures rather than real model accounts. The pet motion regression checks both Windows animation preferences and changes during an interaction. Synthetic inputs and controlled clocks do not establish real-world frame rate or physical mouse feel on every computer. IME, multiple monitors, DPI combinations, GPU compatibility, and long-running desktop use still require manual testing.

[Requirements and design (Chinese)](docs/ChatBubble-需求与设计方案.md) · [Updates and releases (Chinese)](docs/更新与发布.md) · [Changelog (Chinese)](CHANGELOG.md) · [MIT License](LICENSE)
