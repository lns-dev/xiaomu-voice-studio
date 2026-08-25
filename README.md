# 小沐音色工坊

面向 Windows 的本地音色设计与音色克隆桌面软件。

- 音色设计：Qwen3-TTS-12Hz-1.7B-VoiceDesign
- 音色克隆：IndexTTS 2.5
- 单 GPU 安全队列，同一时间只加载一个生成引擎
- 支持情绪描述、情感参考音频、跟随音色参考和手动情绪精调
- 支持参考音频检查、真实声纹、播放控制与可视化裁剪
- 支持候选音色对比、音色库、任务恢复和本地存储清理

## 下载与安装

普通用户请从 GitHub Releases 下载 Windows 安装包。模型权重不包含在安装包中，需要根据各模型官方许可自行下载。

首次启动后进入“引擎设置”：

1. 安装或添加兼容的公共运行环境。
2. 下载 IndexTTS 2.5 与 Qwen3-TTS VoiceDesign 模型。
3. 使用“自动检测”或“添加位置”选择模型目录。

模型、生成结果和软件管理的运行环境默认放在安装目录下的 `models`、`outputs`、`runtime`、`engines` 与 `tools` 目录中。选择自定义安装位置后，这些目录会随安装位置一起变化；升级或卸载应用不会主动删除模型和生成结果。

运行环境组件从本仓库的 GitHub Release 按需获取。模型权重不包含在运行环境或安装包中。

## 运行环境

- Windows 10/11 x64
- NVIDIA GPU，建议至少 8GB 显存
- Python 3.11 x64
- PyTorch 2.8.0 + CUDA 12.8
- Torchaudio 2.8.0

两个引擎共用一套 Python/PyTorch/CUDA 核心，各自使用独立依赖层，避免重复安装两套大型 CUDA 环境。

## 本地开发

```powershell
pnpm install
pnpm start
```

测试：

```powershell
pnpm test
```

生成 Windows 安装包：

```powershell
pnpm dist:win
```

如需复用开发机上的外部环境，可复制 `dev-locations.example.json` 为 `dev-locations.json` 并填写本机路径。该文件已被 Git 忽略。

## 模型与许可

本仓库不分发模型权重。IndexTTS、Qwen3-TTS、PyTorch、FFmpeg 和 7-Zip 等第三方组件分别适用其原始许可证与使用条款。声音克隆功能仅应用于已获得合法授权的声音。

当前为 Alpha 测试版本。公开分发的未签名安装包可能触发 Windows SmartScreen 提示。
