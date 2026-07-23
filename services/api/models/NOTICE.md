# OCR model attribution

These OCR inference models are bundled for the bill-import feature and shipped
in the api Docker image. They are third-party artifacts, redistributed here
under their original license.

## PP-OCRv6_det_small.onnx, el_PP-OCRv5_rec_mobile.onnx, greek_dict.txt

- **Project:** PaddleOCR (PaddlePaddle)
- **Upstream:** https://github.com/PaddlePaddle/PaddleOCR
- **License:** Apache License 2.0
- **ONNX conversion:** models sourced from the RapidOCR distribution
  (https://github.com/RapidAI/RapidOCR), which converts the official PaddleOCR
  PP-OCRv5/v6 weights to ONNX. RapidOCR is also Apache-2.0.

The Apache-2.0 license and its NOTICE requirements apply to these weight files.
The full Apache-2.0 text is at https://www.apache.org/licenses/LICENSE-2.0.
These are public, pre-trained inference weights — no secrets, no PII.
