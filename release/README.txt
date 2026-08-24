小沐音色工坊 Alpha

本安装包不包含语音模型。首次使用时，请在“引擎设置”中：
1. 点击“安装运行环境”。配置 GitHub Release 地址后软件会自动下载；当前离线 Alpha 会提示选择四个运行时资源包所在目录；
2. 下载 IndexTTS 2.5 与 Qwen3-TTS VoiceDesign 官方模型；
3. 使用“自动检测”或“添加位置”选择模型目录。

兼容运行环境：Windows x64、Python 3.11、PyTorch 2.8 CUDA 12.8、Torchaudio 2.8。
模型与生成结果默认保存在 %LOCALAPPDATA%\XiaoMuVoiceStudio，卸载或升级软件不会主动删除这些数据。

此版本为未签名 Alpha 测试包。正式公开发布前需要配置代码签名证书和 GitHub Release 运行时资源地址。
