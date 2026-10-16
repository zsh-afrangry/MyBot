# Offline MIME oracle using Python's standard email parser; no network or private state.
# Development owner: docs/22_论文PDF翻译与文件投递.md; stdin only, decoded metadata/hashes on stdout.
"""Parse complete wire messages captured by the local TLS SMTP regression.

Owned by docs/22_论文PDF翻译与文件投递.md (mail attachment regression).
Input is a complete RFC 5322 message on stdin. Output contains decoded metadata/hashes only.
"""
import email
import email.policy
import hashlib
import json
import sys

message = email.message_from_bytes(sys.stdin.buffer.read(), policy=email.policy.default)
body = message.get_body(preferencelist=("plain",))
print(json.dumps({
    "subject": str(message["Subject"]),
    "multipart": message.is_multipart(),
    "type": message.get_content_type(),
    "body": body.get_content() if body else None,
    "defects": [type(defect).__name__ for part in message.walk() for defect in part.defects],
    "attachments": [{
        "filename": part.get_filename(),
        "disposition": part.get_content_disposition(),
        "type": part.get_content_type(),
        "bytes": len(part.get_payload(decode=True)),
        "sha256": hashlib.sha256(part.get_payload(decode=True)).hexdigest(),
    } for part in message.iter_attachments()],
}, ensure_ascii=False))
