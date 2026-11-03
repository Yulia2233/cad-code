# CAD Code

基于 **OpenCode** 的本地 CAD Agent，提供终端 CLI 和网页两种交互方式。默认使用 **GPT‑6.1 Sol**、完整 **SimpleCADAPI 2.2.5 skill**，执行真实建模、检查、STEP/STL 导出和渲染。

## 现在体验

在本项目目录运行：

```bash
./cad-code                         # OpenCode 交互终端
./cad-code --mini                  # 紧凑终端
./cad-code --web                   # 网页 http://127.0.0.1:8772
./cad-code --continue              # 继续上次会话
./cad-code run '做一个半径10mm、高20mm的圆柱，导出STEP、STL并渲染'
./cad-code run --file ./target.step '检查这个STEP并重建'
```

网页服务启动后，另一个终端运行 `./cad-code` 会连接同一个后端；退出该附加终端不会停止网页。启动服务的终端退出时会清理它管理的后端。CLI 与网页共用会话数据库，产物各自存入 `workspace/<session-id>/`。`--file` 复制输入到本会话 `input/`，不移动原件；单文件上限 32MiB。

## 新机器安装

当前支持 **macOS**，需要 Node.js 22+、OpenCode 1.18.27、Python 3.12/3.13 和系统 `sandbox-exec`。

```bash
git clone https://github.com/Yulia2233/cad-code.git
cd cad-code
npm install -g opencode-ai@1.18.27
npm ci
npm run setup -- --python python3.12
./cad-code --credentials /absolute/path/provider.json
```

API 文件格式如下，填入你自己的服务信息；也支持 `ccvibe.settings` 包装格式：

```json
{"baseURL":"https://your-provider.example/v1","apiKey":"YOUR_API_KEY"}
```

首次启动只在本地记录配置文件路径，后续直接 `./cad-code`。实际 API key 仅网关进程读取，不放入执行器环境；不要提交 API 文件。完整 skill 已随项目固定，文件哈希在 `skills/manifest.json`。

## 工具与记录

Agent 调用标准 `tool_calls` 中的 `exec({code})`，JavaScript 内使用：

```javascript
const r = await tools.exec_command({cmd: "pwd"});
text(r); // 保留 output、exit_code 和运行中 session_id
const view = await tools.view_image({path: "out/model.png", detail: "original"});
image(view.image_url, view.detail);
```

支持 `exec_command`、`write_stdin`、`apply_patch`、`view_image`、`text`、`image`、`ALL_TOOLS`。OpenCode 的 `question`、`todowrite`、`task` 用于需求确认、进度和独立 `cad-review`。子评审只读父任务 `out/`，不能修改父产物。

图片调用默认经 **Responses API** 返回到原 `function_call_output`：保留 `text → image → text` 的实际顺序和原图字节，不走 OpenCode 的附件缩图/合成用户消息。`image(view)` 也可使用；仅 `await view_image()` 不展示图片。`detail=original` 明确映射为上游支持的 `high`，映射留审计；这不表示可控制模型内部的视觉编码。旧会话按原样保留。

| 位置 | 内容 |
|---|---|
| `workspace/<session-id>/` | 输入、notebook、验证脚本和 CAD 产物 |
| `workspace/<session-id>/.cad-events.jsonl` | 原始 JS、完整命令输出、错误、图像与执行记录 |
| `.runtime/xdg/data/opencode/` | OpenCode 会话数据库 |
| `.runtime/model-requests/` | 实际模型请求和完整流式返回，凭据脱敏 |
| `.runtime/tool-media/` | 按会话/工具调用绑定的完整有序文本与原图，供请求恢复和网页预览 |
| `.runtime/events.jsonl` | OpenCode 事件归档 |

网页可查看输入、接口返回的思考、正文、工具调用和结果，展开/折叠、上传文件、预览渲染、下载代码/产物和完整会话 JSON。不会宣称保存 API 未返回的内部思考。

## 配置与验证

默认 `temperature=1`、`reasoning_effort=high`、vision、262144 上下文，输出预算 16384。完整验证结果、设计和限制见 [开发与架构报告](docs/implementation-report.md)。

前两段提示词来自 [英文系统模板](docs/system-prompt.en.md) 和 [运行时模板](docs/runtime-prompt.md) 的英文块，由 plugin 每次请求编译。模型、日期、会话工作目录、Python/skill/工具路径、输入文件和评审父路径动态填充；不会把模板占位符、中文对照或文档说明发送给模型，也不重复追加旧 OpenCode 环境信息。渲染结果及模板 SHA‑256 保存在 `.runtime/prompt-snapshots/`，CLI 和网页使用同一套编译逻辑。

```bash
npm test
```

支持通过 `CAD_CODE_MODEL`、`CAD_CODE_PYTHON`、`CAD_CODE_SKILL`、`OPENCODE_BIN` 覆盖默认组件；`CAD_CODE_WIRE_API=responses` 为默认，也可显式改为 `chat`。不同供应商是否真的支持工具图片必须实测：本次GPT‑6.1接口的Chat工具图片被忽略，Responses已通过实际读图验证；程序不会自动降级、删图或改成用户图片。更换模型/协议需重启后端。默认端口：网页8772、OpenCode18134、模型网关18135，均绑定本机。

本项目是受限兼容原型：CAD 子进程使用非交互 stdin，尚不支持 PTY；执行隔离依赖 macOS Seatbelt，Node `vm` 本身不是安全边界。详细能力边界见报告。

![真实圆柱任务、工具轨迹与渲染产物](docs/images/web-demo.png)
