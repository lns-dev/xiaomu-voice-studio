小沐音色工坊 Beta

本安装包不包含语音模型。首次使用时，请在“引擎设置”中：
1. 点击“安装运行环境”，软件会从本项目的 GitHub Release 按需下载并校验公共 Python/PyTorch/CUDA 环境、两个引擎依赖层与 FFmpeg；
2. 使用每个引擎卡片中的“一键下载完整模型”，或自行下载 IndexTTS 2.5 和 Qwen3-TTS VoiceDesign 官方模型；
3. 必要时使用“自动检测”或“添加位置”选择已有模型目录。

兼容运行环境：Windows 10/11 x64、NVIDIA GPU、Python 3.11、PyTorch 2.8 CUDA 12.8、Torchaudio 2.8。建议至少 8 GB 显存。

运行环境、引擎依赖、模型和生成结果默认分别位于安装目录下的 runtime、engines、models 和 outputs。覆盖安装时安装器会保护并恢复这些目录；直接卸载前请先备份需要保留的模型和结果。

此版本为未签名 Beta 测试包，Windows 可能显示 SmartScreen 提示。软件自有源码使用 Apache License 2.0，第三方组件和模型仍适用其原始条款。
