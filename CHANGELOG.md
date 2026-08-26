# 更新记录

## 0.1.0-beta.1

- Unified the public runtime bundle version and Release asset names under `0.1.0-beta.1`.

- 修复 Qwen 引擎已启动或正在预热时重复执行冷启动显存检查导致的误判。
- 音色克隆在情绪描述为空时于本地界面阻止提交并给出中文提示。
- 新增本地结构化诊断日志与大小轮转，便于保留生成失败信息。
- 增加 Apache-2.0 开源许可、隐私说明、安全政策和发布变更记录。
- 增加独立 pnpm 锁文件与 Windows 打包冒烟 CI 门禁。
- 软件进入公开 Beta 测试阶段，仍为未签名预发布版本。
