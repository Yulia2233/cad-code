# Changelog

## Unreleased — 2026-11-02

- 2026-11-05：新增独立 `ask` 单轮CLI，直接请求提供商，只发送一条用户问题；支持参数/stdin、临时模型/思考覆盖、思考单独输出至stderr，且不启动OpenCode、不注入提示词/历史/工具、不建立本地会话或工作区。

- 2026-11-05：修复Qwen思考已生成但显示为空：将完整`reasoning_text`流事件逐字映射到OpenCode支持的`reasoning_summary_text`协议，原始流、客户端流和审计独立保留；不生成摘要、不修改正文或工具结果。空卡片恢复脚本按会话/item/content index唯一匹配原始事件，不明或重复时跳过；包含8项恢复回归的完整测试143/143通过。

- 2026-11-05：web数据管理与CLI `list` / `delete workspace|conversation`，工作区和对话/轨迹独立删除；轨迹归档后清工作区，对话删除保留代码/模型，防运行中及未确认删除。

- 2026-11-05：网页增加 API 配置面板、模型列表/手动模型 ID及真实思考开关，CLI 增加 `config`、`config --show`、`--base-url`、`--model`、`--list-models`、`--thinking on|off` 与 `--api-key-stdin`；支持首次配置和运行中更新地址/密钥/模型，下次请求生效。密钥隐藏输入、0600本机托管、API不回传，原有外部凭据导入保留。

- 2026-11-05：修复 Qwen Responses 续轮兼容：只将历史助手消息中的 `output_text` 转为 `input_text`，保留文字、角色、顺序及工具调用/结果，并记录转换审计。该修复恢复续轮工具调用，不代表已解决纯文本进度回复后提前停止或完成重建。

- 2026-11-05：默认推理模型切换为公网 Qwen v8（`qwen-v8`，Responses API、temperature=1、256k、vision、reasoning effort medium）。凭据保存在本机权限0600的`~/.secrets/cad-code-qwen-v8.json`；Qwen Responses工具图片为未声明detail的图像补high元数据并审计，保持原图字节不变。

- 2026-11-05：CLI、网页及子会话创建工作区时自动复制 tools/，提供 stepir.py、cadeval.py、families_common.py 和完整评估依赖；提示词指向会话内工具，继续会话时保留已有文件。

- 2026-11-03：前两段提示词改由英文系统/运行时文档模板编译，动态填充真实会话信息；移除旧提示词重复内容，并保留内部压缩及独立评审的角色边界。

- 图片工具改用Responses原生多模态工具返回，保留原图字节、文字/图片顺序和调用归属。
- 新增会话/调用/代码/结果绑定、有序媒体持久化、请求前后审计与原图网页预览。
- 保留真实用户图片和历史记录；不静默缩图、降级或丢图。
- 新增28项图片对齐测试，累计62项通过，并完成真实随机图文读取及重启后历史恢复验证。

## 0.1.0 — 2026-11-02

- 提供 OpenCode 终端 CLI、可选网页和持久会话。
- 集成 GPT‑6.1、完整 SimpleCADAPI2.2.5 skill 与独立 Python 环境。
- 实现 exec(code) JavaScript 编排、CAD 工具、异步轮询、图片反馈与独立评审。
- 增加 macOS 工作区隔离、后台进程清理、完整执行日志和凭据脱敏。
- 提供自动测试、安装入口和架构报告。
