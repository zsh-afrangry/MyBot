"""Authorized real translation API acceptance; synthetic text, no QQ/mail or production writes.

Reads explicit private credentials, writes only --out. No automatic full-PDF job.
Development owner: docs/22_论文PDF翻译与文件投递.md.
Evidence: docs/verification/paper-translation-2026-10-17/channel-upgrade/.
"""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "plugins/kurumi-papers/python"))
from responses import PROFILE_REGISTRY, ResponsesClient, TranslationFailure, registered_profile
from engine import translate_batch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--provider", choices=[p["provider"] for p in PROFILE_REGISTRY["providers"]], default="openai")
    parser.add_argument("--model")
    parser.add_argument("--effort")
    parser.add_argument("--batch", action="store_true", help="Validate a synthetic structured translation batch instead of a plain sentence")
    parser.add_argument("--credential", choices=[k for p in PROFILE_REGISTRY["providers"] for k in p["credentialIds"]], action="append")
    args = parser.parse_args()
    if not args.credentials.is_absolute() or not args.out.is_absolute():
        parser.error("Absolute --credentials and --out are required")
    if not args.credentials.is_file() or args.credentials.is_symlink() or args.credentials.stat().st_mode & 0o077:
        parser.error("Credentials must be an owner-only regular file")
    if args.out.exists():
        parser.error("Output exists; select a new evidence filename")
    spec = next(p for p in PROFILE_REGISTRY["providers"] if p["provider"] == args.provider)
    profile = {k: spec[k] for k in ("provider", "channel", "protocol", "baseUrl")}
    profile.update(model=args.model or spec["defaultModel"], effort=args.effort or spec["defaultEffort"])
    try:
        registered_profile(profile)
    except TranslationFailure:
        parser.error("Unregistered model/effort combination")
    ids = args.credential or spec["credentialIds"]
    if any(name not in spec["credentialIds"] for name in ids):
        parser.error("Credential does not belong to the selected provider")
    keys = json.loads(args.credentials.read_text())
    report = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "boundary": "Real model/API requests with synthetic text and explicitly selected private credentials; no QQ/mail or production writes. Each channel is tested independently, not a forced real failover.",
              "profile": profile, "batch": args.batch, "cases": []}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    for name in ids:
        case = {"credentialId": name}
        report["cases"].append(case)
        client = None
        try:
            client = ResponsesClient(profile, {name: keys.get(name)}, max_requests=2,
                                     max_tokens=50000, timeout=180)
            if args.batch:
                source=[{"id":0,"input":"A Study of Neural Networks"},
                        {"id":1,"input":"Training loss decreases by {v1}."},
                        {"id":2,"input":"<style id='1'>Important</style> findings are reported."}]
                result=translate_batch(client,"## Here is the input:\n"+json.dumps(source),"en","zh")
            else:
                result = client.generate("Neural networks learn useful representations.",
                                         "Translate the sentence into Simplified Chinese. Return only the translation.")
            case.update(ok=True, translation=result)
        except TranslationFailure as error:
            case.update(ok=False, error=str(error))
        if client:
            case["usage"] = client.snapshot()
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"credentialId": name, "ok": case["ok"], "error": case.get("error")}), flush=True)
    report["ok"] = all(case["ok"] for case in report["cases"])
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
