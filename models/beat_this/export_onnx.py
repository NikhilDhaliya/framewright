#!/usr/bin/env python3
"""Export Beat This (small0) to ONNX for the Linux port (spec 07 §3.4).

Same wrapper as the Mac's `models/beat_this/convert.py` (AudioToBeats = LogMelSpect + patched model, fixed input
661059 samples of 22050 Hz mono = one 1500-frame chunk at hop 441), exported with the torch.export-based ONNX exporter (opset 18).

torch.stft with complex output does not export to ONNX, so the exported graph computes the identical log-mel
frontend with a DFT-as-convolution (periodic Hann, centred reflect padding, magnitude × 1/sqrt(1024), Slaney mel,
log1p(1000·x)) — the same maths as torchaudio's MelSpectrogram used by `beat_this.preprocessing.LogMelSpect`.

Parity gates (both must pass, as on the Mac):
  1. the patched torch model places beats like the unmodified upstream pipeline (1-frame tolerance, interior frames);
  2. the ONNX model (onnxruntime, CPU) places identical beats to the patched torch model on the 120 BPM click fixture.

Usage:
  uv venv --python 3.12 .venv
  uv pip install -p .venv/bin/python --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple -r requirements-onnx.txt
  .venv/bin/python export_onnx.py --out resources/models/BeatThis.onnx
"""

import argparse
import hashlib
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import beat_this.model.beat_tracker as bt
import beat_this.model.roformer as rf
import rotary_embedding_torch.rotary_embedding_torch as rot
from beat_this.inference import Audio2Frames, load_model
from beat_this.model.roformer import exists
from beat_this.preprocessing import LogMelSpect

CHECKPOINT = "small0"
SR = 22050
HOP = 441
N_FFT = 1024
CHUNK_FRAMES = 1500
N_SAMPLES = (CHUNK_FRAMES - 1) * HOP
BORDER = 6


# --- The Mac's einops → native-op patches (convert.py), kept verbatim so the traced graph matches the Mac's.

class RearrangeTF(nn.Module):
    def forward(self, x):
        return x.transpose(1, 2).contiguous()


class AddChannel(nn.Module):
    def forward(self, x):
        return x.unsqueeze(1)


class Concat(nn.Module):
    def forward(self, x):
        return x.permute(0, 3, 1, 2).flatten(2, 3)


def partial_forward(self, x):
    y = x.permute(0, 3, 2, 1).flatten(0, 1)
    y = y + self.attnF(y)
    y = y + self.ffF(y)
    y = y.unflatten(0, (1, -1)).permute(0, 2, 1, 3).flatten(0, 1)
    y = y + self.attnT(y)
    y = y + self.ffT(y)
    return y.unflatten(0, (1, -1)).permute(0, 3, 1, 2)


def attn_forward(self, x):
    x = self.norm(x)
    qkv = self.to_qkv(x).unflatten(-1, (3, self.heads, -1)).permute(2, 0, 3, 1, 4)
    q, k, v = qkv[0], qkv[1], qkv[2]
    if exists(self.rotary_embed):
        q = self.rotary_embed.rotate_queries_or_keys(q)
        k = self.rotary_embed.rotate_queries_or_keys(k)
    out = self.attend(q, k, v)
    if exists(self.to_gates):
        gates = self.to_gates(x).permute(0, 2, 1).unsqueeze(-1)
        out = out * gates.sigmoid()
    out = out.permute(0, 2, 1, 3).flatten(2, 3)
    return self.to_out(out)


def sumhead_forward(self, x):
    bd = self.beat_downbeat_lin(x)
    beat, downbeat = bd[..., 0], bd[..., 1]
    return {"beat": beat + downbeat, "downbeat": downbeat}


def rotate_half_native(x):
    x = x.unflatten(-1, (-1, 2))
    x1, x2 = x[..., 0], x[..., 1]
    return torch.stack((-x2, x1), dim=-1).flatten(-2)


def rotate_qk(self, t, seq_dim=None, offset=0, scale=None):
    seq_len = t.shape[-2]
    seq = (torch.arange(seq_len, device=t.device, dtype=self.freqs.dtype) + offset) / self.interpolate_factor
    freqs = (seq[:, None] * self.freqs[None, :]).repeat_interleave(2, dim=-1)
    return t * freqs.cos() + rotate_half_native(t) * freqs.sin()


def apply_patches():
    bt.PartialFTTransformer.forward = partial_forward
    rf.Attention.forward = attn_forward
    bt.SumHead.forward = sumhead_forward
    rot.RotaryEmbedding.rotate_queries_or_keys = rotate_qk


class ConvLogMel(nn.Module):
    """LogMelSpect without complex tensors: |STFT| as two strided convolutions with windowed DFT kernels."""

    def __init__(self, reference: LogMelSpect):
        super().__init__()
        n = torch.arange(N_FFT, dtype=torch.float64)
        k = torch.arange(N_FFT // 2 + 1, dtype=torch.float64)
        window = torch.hann_window(N_FFT, periodic=True, dtype=torch.float64)
        angle = 2 * torch.pi * k[:, None] * n[None, :] / N_FFT
        scale = 1.0 / np.sqrt(N_FFT)  # normalized="frame_length"
        self.register_buffer("cos_k", (torch.cos(angle) * window * scale).float().unsqueeze(1))
        self.register_buffer("sin_k", (-torch.sin(angle) * window * scale).float().unsqueeze(1))
        fb = reference.spect_class.mel_scale.fb  # (513, 128), Slaney, norm None
        self.register_buffer("mel_fb", fb.clone().float())
        self.log_multiplier = reference.log_multiplier

    def forward(self, audio):  # (T,) -> (frames, 128)
        x = audio.view(1, 1, -1)
        x = F.pad(x, (N_FFT // 2, N_FFT // 2), mode="reflect")
        re = F.conv1d(x, self.cos_k, stride=HOP)
        im = F.conv1d(x, self.sin_k, stride=HOP)
        mag = torch.sqrt(re * re + im * im)[0]  # (513, frames)
        mel = torch.matmul(mag.transpose(0, 1), self.mel_fb)  # (frames, 128)
        return torch.log1p(self.log_multiplier * mel)


class AudioToBeats(nn.Module):
    def __init__(self, conv_frontend: bool):
        super().__init__()
        ref = LogMelSpect()
        self.mel = ConvLogMel(ref) if conv_frontend else ref
        model = load_model(CHECKPOINT)
        model.frontend.stem.rearrange_tf = RearrangeTF()
        model.frontend.stem.add_channel = AddChannel()
        model.frontend.concat = Concat()
        self.model = model

    def forward(self, audio):
        out = self.model(self.mel(audio).unsqueeze(0))
        return out["beat"], out["downbeat"]


def click_track():
    """120 BPM clicks, downbeat-accented — the Mac's deterministic parity fixture."""
    dur = N_SAMPLES / SR
    beats = np.arange(0, dur, 0.5)
    x = np.zeros(N_SAMPLES, dtype=np.float32)
    for i, b in enumerate(beats):
        s, n = int(b * SR), int(0.05 * SR)
        env = np.exp(-np.arange(n) / (0.01 * SR))
        freq, amp = (1500, 1.0) if i % 4 == 0 else (1000, 0.6)
        x[s:s + n] += (amp * env * np.sin(2 * np.pi * freq * np.arange(n) / SR)).astype(np.float32)
    return (x / np.abs(x).max() * 0.9).astype(np.float32)


def pick_peaks(logits, thr=0.5):
    p = 1 / (1 + np.exp(-logits))
    return np.array([i for i in range(1, len(p) - 1) if p[i] >= thr and p[i] >= p[i - 1] and p[i] > p[i + 1]])


def peaks_match(a, b, tol=0):
    return len(a) == len(b) and (tol == 0 and np.array_equal(a, b) or np.abs(np.asarray(a) - np.asarray(b)).max() <= tol)


def strip_debug_metadata(path):
    """Drop the exporter's debug metadata (pkg.torch.* / pkg.onnxscript.* props). The per-node stack traces hold
    absolute file paths of the machine that ran the export; the graph and the weights are untouched."""
    import onnx

    model = onnx.load(str(path))

    def clear(graph):
        del graph.metadata_props[:]
        graph.doc_string = ""
        for node in graph.node:
            del node.metadata_props[:]
            node.doc_string = ""
            for attr in node.attribute:
                if attr.HasField("g"):
                    clear(attr.g)
                for sub in attr.graphs:
                    clear(sub)
        for coll in ("input", "output", "value_info", "initializer"):  # FunctionProto lacks some of these
            for v in getattr(graph, coll, []):
                if hasattr(v, "metadata_props"):
                    del v.metadata_props[:]

    clear(model.graph)
    for fn in model.functions:
        clear(fn)
    onnx.save(model, str(path))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("BeatThis.onnx"))
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    click = click_track()

    reference = Audio2Frames(checkpoint_path=CHECKPOINT, device="cpu")
    ref_beat, _ = reference(click, SR)
    ref_beat = np.asarray(ref_beat)

    apply_patches()
    patched = AudioToBeats(conv_frontend=False).eval()
    with torch.no_grad():
        patched_beat, patched_down = patched(torch.from_numpy(click))
    patched_beat = patched_beat.numpy().reshape(-1)
    patched_down = patched_down.numpy().reshape(-1)
    interior = slice(BORDER, -BORDER)
    assert peaks_match(pick_peaks(patched_beat[interior]), pick_peaks(ref_beat[interior]), tol=1), "patched torch model moved a beat vs the original"
    print(f"gate 1 (torch parity): interior max|dlogit|={np.abs(patched_beat[interior] - ref_beat[interior]).max():.3f}, peaks within 1 frame")

    wrapper = AudioToBeats(conv_frontend=True).eval()
    with torch.no_grad():
        conv_beat, _ = wrapper(torch.from_numpy(click))
    print(f"conv frontend vs torch.stft: max|dlogit|={np.abs(conv_beat.numpy().reshape(-1) - patched_beat).max():.5f}")

    # The legacy TorchScript exporter (dynamo=False) segfaults in its ONNX shape-inference pass on this graph with
    # torch 2.8 (CPU); the torch.export-based exporter produces a clean single-file graph. Opset 18 is its minimum.
    torch.onnx.export(
        wrapper,
        (torch.zeros(N_SAMPLES),),
        str(args.out),
        input_names=["audio"],
        output_names=["beat", "downbeat"],
        opset_version=18,
        dynamo=True,
        external_data=False,
    )
    strip_debug_metadata(args.out)

    import onnxruntime as ort

    sess = ort.InferenceSession(str(args.out), providers=["CPUExecutionProvider"])
    onnx_beat, onnx_down = sess.run(["beat", "downbeat"], {"audio": click})
    onnx_beat = np.asarray(onnx_beat).reshape(-1)
    onnx_down = np.asarray(onnx_down).reshape(-1)
    assert not np.isnan(onnx_beat).any(), "NaNs in ONNX output"
    assert np.array_equal(pick_peaks(onnx_beat), pick_peaks(patched_beat)), "ONNX export moved a beat"
    assert np.array_equal(pick_peaks(onnx_down), pick_peaks(patched_down)), "ONNX export moved a downbeat"
    print(f"gate 2 (ONNX parity): max|dlogit|={np.abs(onnx_beat - patched_beat).max():.4f}, beat+downbeat peaks identical")
    print(f"beats on the fixture: {len(pick_peaks(onnx_beat))}, downbeats: {len(pick_peaks(onnx_down))}")
    np.save(args.out.with_suffix(".fixture-beat.npy"), onnx_beat)

    digest = hashlib.sha256(args.out.read_bytes()).hexdigest()
    print(f"done: {args.out} ({args.out.stat().st_size} bytes, sha256 {digest})")


if __name__ == "__main__":
    main()
