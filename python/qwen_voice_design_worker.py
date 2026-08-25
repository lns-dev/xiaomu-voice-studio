#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

PREFIX = "@@VOICE_STUDIO@@"


def emit(payload: dict) -> None:
    print(PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    args = parser.parse_args()
    model = None
    emit({"type": "ready", "engine": "qwen"})
    for raw_line in sys.stdin:
        command = {}
        try:
            command = json.loads(raw_line)
            if command.get("type") not in {"design", "warmup"}:
                raise ValueError("Unsupported command")
            if model is None:
                emit({"type": "progress", "id": command["id"], "stage": "loading_model", "percent": 12, "message": "正在加载音色设计引擎"})
                import torch
                from qwen_tts import Qwen3TTSModel
                from qwen_tts.inference.qwen3_tts_tokenizer import Qwen3TTSTokenizer
                if not torch.cuda.is_available():
                    raise RuntimeError("CUDA unavailable; refusing CPU fallback")
                torch.set_float32_matmul_precision("high")
                torch.backends.cuda.matmul.allow_tf32 = True
                torch.backends.cudnn.allow_tf32 = True
                torch.cuda.set_per_process_memory_fraction(0.84, device=0)
                torch.cuda.empty_cache()
                torch.cuda.reset_peak_memory_stats(0)
                # The 12 Hz speech tokenizer is used only to decode generated
                # codes. Keeping it on CPU saves roughly 650 MB of model
                # weights on this 6 GB GPU without changing the generated
                # codes or audio math. The 1.7B talker remains BF16 on CUDA.
                original_tokenizer_loader = Qwen3TTSTokenizer.from_pretrained.__func__
                tokenizer_mode = os.environ.get("XIAOMU_QWEN_TOKENIZER_DEVICE", "auto").strip().lower()
                free_cuda_bytes, _ = torch.cuda.mem_get_info(0)
                use_cuda_tokenizer = tokenizer_mode in {"cuda", "cuda:0"} or (
                    tokenizer_mode == "auto" and free_cuda_bytes >= 4608 * 1024**2
                )
                tokenizer_device = "cuda:0" if use_cuda_tokenizer else "cpu"

                def tokenizer_on_selected_device(cls, model_path, **kwargs):
                    kwargs["device_map"] = "cuda:0" if use_cuda_tokenizer else "cpu"
                    kwargs["dtype"] = torch.bfloat16 if use_cuda_tokenizer else torch.float32
                    kwargs.pop("attn_implementation", None)
                    return original_tokenizer_loader(cls, model_path, **kwargs)

                Qwen3TTSTokenizer.from_pretrained = classmethod(tokenizer_on_selected_device)
                try:
                    model = Qwen3TTSModel.from_pretrained(
                        str(args.model.resolve(strict=True)),
                        device_map="cuda:0",
                        dtype=torch.bfloat16,
                        attn_implementation="sdpa",
                        local_files_only=True,
                    )
                finally:
                    Qwen3TTSTokenizer.from_pretrained = classmethod(original_tokenizer_loader)
                emit({"type": "progress", "id": command["id"], "stage": "model_ready", "percent": 45, "message": f"音色设计引擎已加载（{'GPU 高速解码' if use_cuda_tokenizer else 'CPU 节省显存解码'}）"})
            if command.get("type") == "warmup":
                emit({"type": "result", "id": command["id"], "result": {"ready": True}})
                continue
            output = Path(command["output"]).resolve(strict=False)
            output.parent.mkdir(parents=True, exist_ok=True)
            emit({"type": "progress", "id": command["id"], "stage": "synthesizing", "percent": 55, "message": "正在根据描述设计新音色"})
            started = time.perf_counter()
            seed = int(command["seed"])
            torch.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
            with torch.inference_mode():
                wavs, sample_rate = model.generate_voice_design(
                    text=command["text"],
                    language=command["language"],
                    instruct=command["instruction"],
                    do_sample=True,
                    temperature=float(command["temperature"]),
                    top_p=float(command["topP"]),
                    top_k=int(command["topK"]),
                    repetition_penalty=float(command["repetitionPenalty"]),
                )
            import soundfile as sf
            sf.write(str(output), wavs[0], sample_rate, subtype="PCM_16")
            emit({"type": "result", "id": command["id"], "result": {
                "output": str(output),
                "durationSeconds": round(len(wavs[0]) / sample_rate, 3),
                "sampleRate": sample_rate,
                "generationSeconds": round(time.perf_counter() - started, 3),
                "torchPeakAllocatedMiB": round(torch.cuda.max_memory_allocated(0) / 1024**2, 1),
                "torchPeakReservedMiB": round(torch.cuda.max_memory_reserved(0) / 1024**2, 1),
                "decoderDevice": tokenizer_device,
            }})
        except Exception as exc:
            emit({"type": "error", "id": command.get("id"), "message": str(exc), "trace": traceback.format_exc()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
