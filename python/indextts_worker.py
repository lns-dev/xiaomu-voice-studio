#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gc
import json
import os
import random
import sys
import time
import traceback
import types
import wave
from pathlib import Path

PREFIX = "@@VOICE_STUDIO@@"


def emit(payload: dict) -> None:
    print(PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    return parser.parse_args()


class IndexWorker:
    def __init__(self, repo: Path, model: Path) -> None:
        self.repo = repo.resolve(strict=True)
        self.model = model.resolve(strict=True)
        self.tts = None
        self.torch = None
        self.emotion_analyzer = None

    def prepare_runtime(self) -> None:
        if str(self.repo) not in sys.path:
            sys.path.insert(0, str(self.repo))
        os.chdir(self.repo)
        if self.torch is None:
            import torch
            self.torch = torch
            torch.set_float32_matmul_precision("high")
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

    def analyze_emotion_text(self, job_id: str, emotion_text: str) -> list[float]:
        self.prepare_runtime()
        emit({"type": "progress", "id": job_id, "stage": "analyzing_emotion", "percent": 8, "message": "正在分析情绪描述文本"})
        import indextts.infer_v2_5 as infer_module

        model_dir = self.model / "qwen0.6bemo4-merge"
        if not model_dir.is_dir():
            raise RuntimeError("缺少 IndexTTS 官方 QwenEmotion 子模型")
        original_loader = infer_module.AutoModelForCausalLM.from_pretrained

        def load_on_cpu(*args, **kwargs):
            kwargs["device_map"] = "cpu"
            kwargs["torch_dtype"] = self.torch.float32
            kwargs["local_files_only"] = True
            kwargs["low_cpu_mem_usage"] = True
            return original_loader(*args, **kwargs)

        if self.emotion_analyzer is None:
            infer_module.AutoModelForCausalLM.from_pretrained = load_on_cpu
            try:
                self.emotion_analyzer = infer_module.QwenEmotion(str(model_dir))
            finally:
                infer_module.AutoModelForCausalLM.from_pretrained = original_loader
        try:
            emotion = self.emotion_analyzer.inference(emotion_text)
            vector = [float(value) for value in emotion.values()]
            if len(vector) != 8:
                raise RuntimeError("QwenEmotion 未返回完整的 8 维情绪向量")
            emit({"type": "progress", "id": job_id, "stage": "emotion_ready", "percent": 18, "message": "情绪描述已解析"})
            return vector
        finally:
            gc.collect()

    def load(self, job_id: str) -> None:
        if self.tts is not None:
            return
        emit({"type": "progress", "id": job_id, "stage": "loading_model", "percent": 12, "message": "正在加载音色克隆引擎（首次约 1 分钟）"})
        self.prepare_runtime()
        torch = self.torch

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA unavailable; refusing CPU fallback")
        torch.cuda.set_device(0)
        torch.cuda.set_per_process_memory_fraction(0.84, device=0)
        torch.cuda.empty_cache()
        from indextts.utils import checkpoint as checkpoint_utils

        def mmap_assign_checkpoint(model_obj: torch.nn.Module, model_path: str) -> dict:
            state = torch.load(model_path, map_location="cpu", mmap=True, weights_only=True)
            missing, unexpected = model_obj.load_state_dict(state, strict=False, assign=True)
            if missing or unexpected:
                raise RuntimeError(f"Checkpoint mismatch: missing={missing}, unexpected={unexpected}")
            return state

        checkpoint_utils.load_checkpoint = mmap_assign_checkpoint
        import indextts.infer_v2_5 as infer_module

        wav2vec_class = infer_module.Wav2Vec2BertModel
        original_wav2vec_to = wav2vec_class.to

        def keep_wav2vec_on_cpu(module: torch.nn.Module, *args, **kwargs):
            return original_wav2vec_to(module, device="cpu")

        wav2vec_class.to = keep_wav2vec_on_cpu
        try:
            tts = infer_module.IndexTTS2(
                cfg_path=str(self.model / "config.yaml"),
                model_dir=str(self.model),
                use_bf16=True,
                device="cuda:0",
                use_cuda_kernel=False,
                use_deepspeed=False,
                use_accel=False,
                use_torch_compile=False,
                use_qwen_emo=False,
            )
        finally:
            wav2vec_class.to = original_wav2vec_to
        tts.semantic_model = tts.semantic_model.to("cpu").eval()
        tts.semantic_mean = tts.semantic_mean.to("cpu")
        tts.semantic_std = tts.semantic_std.to("cpu")

        @torch.no_grad()
        def get_emb_cpu(instance, input_features, attention_mask):
            cached_inputs = getattr(instance, "_xiaomu_emb_cache_inputs", None)
            if cached_inputs and cached_inputs[0] is input_features and cached_inputs[1] is attention_mask:
                return instance._xiaomu_emb_cache_value
            result = instance.semantic_model(
                input_features=input_features.to("cpu"),
                attention_mask=attention_mask.to("cpu"),
                output_hidden_states=True,
            )
            features = (result.hidden_states[17] - instance.semantic_mean) / instance.semantic_std
            features = features.to(instance.device)
            instance._xiaomu_emb_cache_inputs = (input_features, attention_mask)
            instance._xiaomu_emb_cache_value = features
            return features

        tts.get_emb = types.MethodType(get_emb_cpu, tts)
        torch.cuda.empty_cache()
        self.tts = tts
        emit({"type": "progress", "id": job_id, "stage": "model_ready", "percent": 45, "message": "音色克隆引擎已加载"})

    def prepare_reference(self, job_id: str, reference: str) -> bool:
        self.load(job_id)
        tts = self.tts
        reference = str(Path(reference).resolve(strict=True))
        if tts.cache_spk_audio_prompt == reference and tts.cache_emo_audio_prompt == reference:
            return True
        emit({"type": "progress", "id": job_id, "stage": "preparing_reference", "percent": 48, "message": "正在后台分析参考音频"})
        import torchaudio

        with self.torch.inference_mode():
            if tts.cache_spk_cond is not None:
                tts.cache_spk_cond = None
                tts.cache_s2mel_style = None
                tts.cache_s2mel_prompt = None
                tts.cache_mel = None
                self.torch.cuda.empty_cache()
            audio, sample_rate = tts._load_and_cut_audio(reference, 15, False)
            audio_22k = torchaudio.transforms.Resample(sample_rate, 22050)(audio)
            audio_16k = torchaudio.transforms.Resample(sample_rate, 16000)(audio)
            inputs = tts.extract_features(audio_16k, sampling_rate=16000, return_tensors="pt")
            input_features = inputs["input_features"].to(tts.device)
            attention_mask = inputs["attention_mask"].to(tts.device)
            spk_cond_emb = tts.get_emb(input_features, attention_mask)
            ref_mel = tts.mel_fn(audio_22k.to(spk_cond_emb.device).float())
            ref_target_lengths = self.torch.LongTensor([ref_mel.size(2)]).to(ref_mel.device)
            feat = torchaudio.compliance.kaldi.fbank(
                audio_16k.to(ref_mel.device), num_mel_bins=80, dither=0, sample_frequency=16000
            )
            feat = feat - feat.mean(dim=0, keepdim=True)
            style = tts.campplus_model(feat.unsqueeze(0))
            prompt_condition = tts.s2mel.models["length_regulator"](
                spk_cond_emb, ylens=ref_target_lengths, n_quantizers=3, f0=None
            )[0]
            tts.cache_spk_cond = spk_cond_emb
            tts.cache_s2mel_style = style
            tts.cache_s2mel_prompt = prompt_condition
            tts.cache_spk_audio_prompt = reference
            tts.cache_mel = ref_mel
            tts.cache_emo_cond = spk_cond_emb
            tts.cache_emo_audio_prompt = reference
            tts._xiaomu_emb_cache_inputs = None
            tts._xiaomu_emb_cache_value = None
        emit({"type": "progress", "id": job_id, "stage": "reference_ready", "percent": 50, "message": "参考音频特征已缓存"})
        return True

    def synthesize(self, command: dict) -> dict:
        job_id = command["id"]
        emotion_vector = command.get("emotionVector")
        if command.get("emotionMode") == "text":
            emotion_vector = self.analyze_emotion_text(job_id, command["emotionText"])
        self.load(job_id)
        output = Path(command["output"]).resolve(strict=False)
        output.parent.mkdir(parents=True, exist_ok=True)
        emit({"type": "progress", "id": job_id, "stage": "synthesizing", "percent": 55, "message": "正在克隆音色并合成语音"})
        started = time.perf_counter()
        seed = int(command["seed"])
        random.seed(seed)
        self.torch.manual_seed(seed)
        self.torch.cuda.manual_seed_all(seed)
        with self.torch.inference_mode():
            self.tts.infer(
                spk_audio_prompt=command["reference"],
                text=command["text"],
                output_path=str(output),
                lang="ZH",
                emo_audio_prompt=command.get("emotionAudio") if command.get("emotionMode") == "audio" else None,
                emo_vector=emotion_vector,
                emo_alpha=float(command["emotionStrength"]),
                use_emo_text=False,
                use_random=False,
                duration_factor=float(command["durationFactor"]),
                interval_silence=int(command["intervalSilence"]),
                temperature=float(command["temperature"]),
                top_p=float(command["topP"]),
                top_k=int(command["topK"]),
                repetition_penalty=float(command["repetitionPenalty"]),
                verbose=False,
            )
        if not output.is_file() or output.stat().st_size <= 44:
            raise RuntimeError("IndexTTS produced no valid WAV")
        with wave.open(str(output), "rb") as audio:
            duration = audio.getnframes() / audio.getframerate()
            sample_rate = audio.getframerate()
        return {
            "output": str(output),
            "durationSeconds": round(duration, 3),
            "sampleRate": sample_rate,
            "generationSeconds": round(time.perf_counter() - started, 3),
            "resolvedEmotionVector": emotion_vector,
            "emotionAnalyzer": "QwenEmotion (CPU)" if command.get("emotionMode") == "text" else None,
        }


def main() -> int:
    args = parse_args()
    worker = IndexWorker(args.repo, args.model)
    emit({"type": "ready", "engine": "index"})
    for raw_line in sys.stdin:
        try:
            command = json.loads(raw_line)
            if command.get("type") == "warmup":
                worker.load(command["id"])
                reference_prepared = bool(command.get("reference")) and worker.prepare_reference(command["id"], command["reference"])
                emit({"type": "result", "id": command["id"], "result": {"ready": True, "referencePrepared": reference_prepared}})
                continue
            if command.get("type") != "synthesize":
                raise ValueError("Unsupported command")
            result = worker.synthesize(command)
            emit({"type": "result", "id": command["id"], "result": result})
        except Exception as exc:
            emit({"type": "error", "id": command.get("id") if "command" in locals() else None, "message": str(exc), "trace": traceback.format_exc()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
