"""Python producer for execution-schema.sql. Private evidence; no business decisions."""
import hashlib
import contextlib
import json
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid
import zlib

SECRET = re.compile(r"token|secret|password|passwd|authorization|cookie|api[_-]?key|credential|private[_-]?key", re.I)
COUNT = re.compile(r"^(?:(?:input|output|total|reported|reasoning|completion|prompt|cached|cache_read|cache_write|max_output|max_reported|max_input)_?tokens|(?:input|output|total|reported|reasoning|completion|prompt|cached|cacheRead|cacheWrite|maxOutput|maxReported|maxInput)Tokens)$")
TOKEN_DETAILS = re.compile(r"^(?:(?:input|output|prompt|completion)_tokens_details|(?:input|output|prompt|completion)TokensDetails)$")


def redact(value, secrets=(), key=""):
    if SECRET.search(key) and not (COUNT.fullmatch(key) and type(value) in (int, float)) and not (TOKEN_DETAILS.fullmatch(key) and isinstance(value, dict)):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {k: redact(v, secrets, k) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, secrets) for v in value]
    if isinstance(value, str):
        value = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", value, flags=re.I)
        value = re.sub(r"\b(?:sk|key|token)[-_][A-Za-z0-9._~-]{12,}\b", "[REDACTED]", value, flags=re.I)
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[REDACTED]")
    return value


class TraceStore:
    def __init__(self, root, execution_id, parent_id, *, correlation=None, secrets=(), body_bytes=4*1024*1024,
                 store_bytes=256*1024*1024, retention_ms=30*86400000, now=None):
        self.root, self.execution_id, self.parent_id = Path(root), execution_id, parent_id
        self.correlation, self.secrets = correlation or {}, tuple(secrets)
        self.body_bytes, self.store_bytes, self.retention_ms = body_bytes, store_bytes, retention_ms
        self.now = now or (lambda: int(time.time()*1000))
        self.lock = threading.RLock()
        self.failed = False

    @contextlib.contextmanager
    def _db(self):
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.is_symlink():
            raise ValueError("trace_directory_symlink")
        self.root.chmod(0o700)
        file = self.root / "executions.sqlite"
        if file.is_symlink():
            raise ValueError("trace_file_symlink")
        conn = sqlite3.connect(file, timeout=.25)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(Path(__file__).with_name("execution-schema.sql").read_text())
        file.chmod(0o600)
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def _failed(self):
        self.failed = True
        return {"status": "capture_failed", "code": "trace_storage_error"}

    def cache_origin(self, key, span_id=None):
        try:
            with self.lock, self._db() as conn:
                if span_id:
                    conn.execute("INSERT OR REPLACE INTO trace_cache_origins VALUES (?,?,?,?)",
                                 (key,self.execution_id,span_id,self.now()))
                    conn.execute("DELETE FROM trace_cache_origins WHERE created_ms < ?", (self.now()-self.retention_ms,))
                row=conn.execute("SELECT execution_id,span_id FROM trace_cache_origins WHERE cache_key=?", (key,)).fetchone()
                return {"executionId":row[0],"spanId":row[1]} if row else {"status":"origin_unknown"}
        except Exception:
            return self._failed()

    def detail(self, value):
        try:
            raw = json.dumps(redact(value, self.secrets), ensure_ascii=False, separators=(",", ":")).encode()
            if len(raw) > self.body_bytes:
                return {"status": "too_large", "bytes": len(raw), "limit": self.body_bytes}
            content, at, ident = zlib.compress(raw), self.now(), str(uuid.uuid4())
            if len(content) > self.store_bytes:
                return {"status": "capacity_exceeded"}
            digest = hashlib.sha256(raw).hexdigest()
            with self.lock, self._db() as conn:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("DELETE FROM trace_details WHERE expires_ms <= ?", (at,))
                size = conn.execute("SELECT COALESCE(SUM(length(content)),0) FROM trace_details").fetchone()[0]
                for row in conn.execute("SELECT id,length(content) FROM trace_details ORDER BY created_ms,id").fetchall():
                    if size + len(content) <= self.store_bytes:
                        break
                    conn.execute("DELETE FROM trace_details WHERE id=?", (row[0],))
                    size -= row[1]
                conn.execute("INSERT INTO trace_details VALUES (?,?,?,?,?,?)", (ident,at,at+self.retention_ms,digest,len(raw),content))
            from datetime import datetime, timezone
            return {"status":"stored", "id":ident, "sha256":digest, "bytes":len(raw),
                    "expiresAt":datetime.fromtimestamp((at+self.retention_ms)/1000, timezone.utc).isoformat()}
        except Exception:
            return self._failed()

    def node(self, ident, node_type, name, status, *, parent=None, **data):
        try:
            at = self.now()
            from datetime import datetime, timezone
            record = redact({"schemaVersion":1, "eventId":str(uuid.uuid4()), "epochMs":at,
                "at":datetime.fromtimestamp(at/1000, timezone.utc).isoformat(), "source":"papers", "kind":"execution.node",
                "correlation":{**self.correlation,"executionId":self.execution_id,"spanId":ident,
                               **({"parentSpanId":self.parent_id if parent is None else parent} if (self.parent_id if parent is None else parent) else {})},
                "data":{"business":"papers","type":node_type,"name":name,"status":status,**data}}, self.secrets)
            with self.lock, self._db() as conn:
                conn.execute("INSERT INTO trace_events VALUES (?,?,?,?,?)",
                    (record["eventId"],self.execution_id,ident,at,json.dumps(record,ensure_ascii=False)))
                conn.execute("DELETE FROM trace_events WHERE at_ms < ?", (at-self.retention_ms,))
                conn.execute("DELETE FROM trace_events WHERE rowid IN (SELECT rowid FROM trace_events ORDER BY at_ms DESC,event_id DESC LIMIT -1 OFFSET 100000)")
            return record
        except Exception:
            return self._failed()
