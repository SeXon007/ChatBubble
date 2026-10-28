const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
async function main() {
  const root = path.resolve(__dirname, '..');
  const pkg = require(path.join(root, 'package.json'));
  const output = path.join(root, 'release', `ChatBubble-${pkg.version}-win32-x64`);
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This package target requires Windows x64.');
  try { await fs.access(output); throw new Error(`Output already exists: ${output}. Preserve it or choose a new version before packaging.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Electron 45 downloads its runtime on demand; clean CI has no dist yet.
  execFileSync(process.execPath, [path.join(root, 'node_modules/electron/install.js')], { stdio: 'inherit', windowsHide: true });
  await fs.cp(path.join(root, 'node_modules/electron/dist'), output, { recursive: true });
  await fs.rename(path.join(output, 'electron.exe'), path.join(output, 'ChatBubble.exe'));
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/set-exe-icon.ps1'), '-Exe', path.join(output, 'ChatBubble.exe'), '-Icon', path.join(root, 'src/assets/app.ico')], { stdio: 'inherit', windowsHide: true });
  const app = path.join(output, 'resources', 'app');
  await fs.mkdir(app, { recursive: true });
  await fs.cp(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true });
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, productName: 'ChatBubble', version: pkg.version, main: 'dist/main.js' }, null, 2));
  await fs.copyFile(path.join(root, 'README.md'), path.join(output, 'README.md'));
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE.ChatBubble.txt'));
  await fs.mkdir(path.join(output, 'chat'), { recursive: true });
  await fs.writeFile(path.join(output, '运行说明.txt'), [
    '先从托盘退出旧版，再双击 ChatBubble.exe。左键点击史莱姆伸展为输入框，点击外部后缩回；左键拖到屏幕边缘松手后贴合。右键单击跳跃躲避，按住右键拖动原地拉伸、松手回弹。单击托盘切换显示/隐藏，托盘右键提供开始新对话、设置和退出。设置修改自动保存。设置→聊天→消息区高度可在120–800px间调整，默认380px，重启恢复，实际显示受屏幕空间限制，底部输入条仍固定42px。',
    '设置提供连接、聊天、外观、桌宠、版本五个等宽选项卡，窗口可拖动边框调整大小或最大化。版本页显示实际应用版本，点击检查从GitHub读取最新正式版本；发现新版可下载并核对SHA-256，准备好后点击重启并更新。新版放在独立目录，旧包和聊天保留，保存失败取消重启。首次从旧0.13.x升级需手动运行本版，后续可在版本页更新。API 服务商提供 DeepSeek、Kimi、智谱 GLM 和自定义，预设自动填地址，模型可下拉选择或手填；模型目录读取失败时保留常用候选，候选不代表账户权限已验证。切换服务需使用对应 API Key。',
    '输入框固定为紧凑单条，截图键紧邻发送键。Codex CLI及支持识图的API模型可用，点击截图键才读取画面，成功后自动将图片复制到系统剪贴板；复制失败会提示并保留待发送截图；设置→聊天→截图范围可选择前台窗口或整个屏幕，默认保留前台窗口。整个屏幕包含鼠标所在显示器的桌面、多个可见窗口及任务栏，使用Windows原生窗口排除机制跳过ChatBubble自身的聊天、输入框、桌宠及设置，显示其底下的画面；截图时不隐藏/恢复窗口或改变焦点。PNG保留捕获的原始分辨率，不再缩到1920px；保存、剪贴板和模型发送都使用原图，单图16 MB和原生1600万像素限制不变。完整排除需Windows 10 2004或更新版本，其他遵守该机制的截图/录屏工具也会跳过本应用；不拼接全部显示器。切换范围自动保存并解除未发送旧图关联，不触发截图。打开、拖动、长按松开和文字发送不自动截图。已截图时再次点击可重新截图或移除，浮层只有两个图标，悬停显示说明。发送后清除本次关联，收起再展开保留，重启不恢复未发送图；移除不删除文件。失败显示“未能读取画面”，不复用旧图。设置不再提供自动读屏。API截图可选DeepSeek deepseek-flash、Kimi kimi-k3.1-pro/kimi-k3、智谱GLM-4.6V-Flash。未确认的官方模型禁用截图，自定义API需支持image_url。失败重试复用原图；成功历史图在预算内随追问重发并增加图片用量。单图16 MB、最多8图、总原图24 MB。更换服务或模型解除未发送关联。Claude CLI 已移除。',
    '新用户聊天默认放在本文件夹内 chat；已有自定义聊天目录继续使用，可在设置查看。chat 内 state.json 保存当前状态，sessions 保存归档，attachments 统一保存截图及附件。所有已保存图片均不自动删除，由用户手动清理；删除历史引用的图片后，回看原图或重试可能找不到文件。旧 screenshot 中的普通文件校验迁入 attachments，不覆盖重名附件，迁空后移除旧目录；自建子目录或链接保留。升级时保留 chat，不覆盖用户数据。历史按Codex CLI、DeepSeek、Kimi、智谱和不同自定义API地址隔离；切换来源先归档消息与草稿，再新开对话。同一家服务切换模型继续原会话。旧记录来源无法确认时原样保留在本地文件夹，显示未分类，不参与混用。',
    'Codex 桌面端追加的已完成消息可同步回来继续聊；若提示其他应用占用，请在那边关闭会话后重试。不是同时在两边生成，也不会自动抢占或回退外部消息。',
    '保持整个便携文件夹完整；不需要 Node.js，使用CLI时目标电脑仍需安装并登录 Codex CLI。凭据及存储位置配置保留在 %APPDATA%\\ChatBubble。Codex 原生会话仍由其自身数据目录保存，移动 chat 不等于跨电脑迁移全部 Codex 会话。',
    '未签名 Windows x64 候选版；其他软件的画面兼容性、多屏与全部 DPI、真实输入法及桌面端图片展示仍需人工体验。Electron 许可证见 LICENSE 和 LICENSES.chromium.html。'
  ].join('\r\n'));
  console.log(output);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
