#!/usr/bin/env bash
# Install the pinned on-demand Python runtime. Writes runtime environment, no model/QQ/mail call.
# Development and acceptance contract: docs/22_论文PDF翻译与文件投递.md.
set -euo pipefail
paper_repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
paper_prefix=${1:-/home/afrangry/.openclaw-fusion/venvs/paper-translation}
paper_conda=${KURUMI_CONDA:-/home/afrangry/miniconda3/bin/conda}
if [[ ! -x "$paper_prefix/bin/python" ]]; then
  "$paper_conda" create --prefix "$paper_prefix" python=3.12 pip -y
fi
"$paper_prefix/bin/python" -m pip install -r "$paper_repo/chatbot/plugins/kurumi-papers/python/requirements.lock.txt"
"$paper_prefix/bin/python" -m pip check
"$paper_prefix/bin/python" -c 'import importlib.metadata as m; from pdf2zh_next.translator.base_translator import BaseTranslator; from babeldoc.format.pdf.high_level import do_translate; from babeldoc.progress_monitor import ProgressMonitor; assert m.version("pdf2zh-next")=="2.9.0"; assert m.version("babeldoc")=="0.6.2"; print("paper runtime OK")'
