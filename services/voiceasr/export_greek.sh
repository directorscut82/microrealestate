#!/usr/bin/env bash
# Export a MONOLINGUAL Greek wav2vec2-CTC to ONNX.
#
# WHY: omniASR covers 1600 languages and, on spans under ~1.5s, misidentifies Greek as Arabic or
# Hindi — measured, with «τρία» decoding to «ترية». A Greek-only model has ~40 Greek characters in
# its vocabulary and structurally cannot make that error.
#
# jonatasgrosman/wav2vec2-large-xlsr-53-greek: 1.78M downloads/month, character-level CTC vocab of
# 41 tokens with <pad> as blank — the same decoder shape already running for OCR.
set -e
cd "$(dirname "$0")"
# Any CPython 3.11/3.12 with torch wheels works; the original hardcoded a macOS
# homebrew path, which the ops review correctly called out as unreproducible on
# a Linux CI box.
PY_BIN="${PYTHON:-python3.12}"
"$PY_BIN" -m venv .venv-export 2>/dev/null || true
.venv-export/bin/pip -q install --upgrade pip
.venv-export/bin/pip -q install "torch==2.13.0" "transformers==5.15.0" "onnx==1.22.0" "onnxruntime==1.28.0" "onnxscript==0.7.1" "numpy==1.26.4"
.venv-export/bin/python - <<'PY'
import torch, json, os
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
MODEL='jonatasgrosman/wav2vec2-large-xlsr-53-greek'
os.makedirs('greek-onnx', exist_ok=True)
proc = Wav2Vec2Processor.from_pretrained(MODEL)
model = Wav2Vec2ForCTC.from_pretrained(MODEL).eval()
vocab = proc.tokenizer.get_vocab()
json.dump(vocab, open('greek-onnx/vocab.json','w'), ensure_ascii=False)
print('vocab size', len(vocab), '| pad/blank id', proc.tokenizer.pad_token_id)
dummy = torch.randn(1, 16000*2)
torch.onnx.export(model, dummy, 'greek-onnx/model.onnx',
    input_names=['input_values'], output_names=['logits'],
    dynamic_axes={'input_values':{0:'b',1:'t'}, 'logits':{0:'b',1:'t'}},
    opset_version=14)
print('exported fp32', os.path.getsize('greek-onnx/model.onnx')//1048576, 'MB')
from onnxruntime.quantization import quantize_dynamic, QuantType
# op_types_to_quantize=['MatMul'] is REQUIRED: the default also quantizes the 1-D conv frontend and
# the resulting model fails to load with NOT_IMPLEMENTED ConvInteger.
quantize_dynamic('greek-onnx/model.onnx','greek-onnx/model.int8.onnx',
                 weight_type=QuantType.QInt8, op_types_to_quantize=['MatMul'])
print('quantized int8', os.path.getsize('greek-onnx/model.int8.onnx')//1048576, 'MB')
PY
