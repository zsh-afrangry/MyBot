"""Native Responses transport, bounded retries and shared credential cooldown. Contract: docs/22.

Standard library only, so tests can inject an HTTP transport without a model or Python PDF runtime.
No SDK retries, upstream Chat calls or upstream translator health-check requests are used.
"""
import collections
import contextlib
import hashlib
import copy
import http.client
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import threading
import tempfile
import time
import urllib.error
import urllib.request

PROFILE_REGISTRY = json.loads(Path(__file__).with_name("profiles.json").read_text())
# Compatibility name for the ordered GPT pool; actual selection is always provider-specific.
KEY_IDS = tuple(next(p for p in PROFILE_REGISTRY["providers"] if p["provider"] == "openai")["credentialIds"])
PROMPT_VERSION = "kurumi-paper-v2-batch"
AUTH_CODES = ("invalid_api_key", "authentication_error", "key_disabled")
QUOTA_CODES = ("insufficient_quota", "quota_exceeded", "credit_balance_too_low")
CHANNEL_ERROR_CODES = ("upstream_stream_read_error", "upstream_error", "server_error",
                       "internal_server_error", "service_unavailable", "overloaded_error",
                       "gateway_timeout", "upstream_http2_stream_error")
CHANNEL_HTTP_STATUSES = (408, 500, 502, 503, 504, 520, 522, 524, 529)
CHANNEL_FAILURES = ("api_transport_unknown", "api_request_timed_out_unknown",
                    "api_stream_interrupted_unknown")


def placeholders(text):
    return collections.Counter(re.findall(r"\{v\d+\}|</?b\d+>|<style\s+id=['\"]\d+['\"]>|</style>", text))


def marker_validation(source, output):
    """Generated markup only; never include document/translation prose in diagnostics."""
    expected, actual = placeholders(source), placeholders(output)
    return {"reason": "placeholder_mismatch", "expectedPlaceholders": sum(expected.values()),
            "actualPlaceholders": sum(actual.values()), "expectedMarkers": dict(expected),
            "missingMarkers": dict(expected - actual), "extraMarkers": dict(actual - expected)}


def validation_retry_hint(validation):
    detail = {k: validation[k] for k in ("itemIndex", "expectedMarkers", "missingMarkers", "extraMarkers")
              if k in validation}
    return (" The previous attempt failed local validation: " + validation["reason"] +
            ". Re-translate this same batch. Check every id and preserve EVERY formula and "
            "opening/closing style marker with exactly the original count and IDs in each item. "
            "For a marker mismatch, itemIndex is zero-based; use this exact marker checklist. "
            "Do not omit a marker even if it represents punctuation, a reference or repeated styling. "
            "Local structural diagnostic: " + json.dumps(detail, ensure_ascii=False))


class TranslationFailure(Exception):
    """Messages are locally generated codes, never upstream bodies, paper text or credentials."""

    def __init__(self, code, details=None):
        super().__init__(code)
        self.details = details or {}


def registered_profile(profile):
    """Defence in depth in the worker; no model-selected hosts or cross-provider keys."""
    spec = next((p for p in PROFILE_REGISTRY["providers"]
                 if p["provider"] == profile.get("provider") and p["channel"] == profile.get("channel")), None)
    if (not spec or profile.get("baseUrl") != spec["baseUrl"] or
            profile.get("protocol") != spec["protocol"]):
        raise TranslationFailure("unsupported_translation_endpoint")
    if profile.get("effort") not in spec["models"].get(profile.get("model"), []):
        raise TranslationFailure("unsupported_translation_profile")
    return spec


def safe_error_details(data):
    """Only machine identifiers; arbitrary messages can contain prompts or credentials."""
    error = data.get("error", data) if isinstance(data, dict) else {}
    if not isinstance(error, dict):
        return {}
    return {"apiError" + field.title(): value for field in ("code", "type", "param")
            if isinstance((value := error.get(field)), str)
            and re.fullmatch(r"[a-zA-Z0-9_.\[\]-]{1,100}", value)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_request(url, key, body, timeout, on_progress=None, cancel_event=None):
    """Supervise one disposable HTTP worker so blocking DNS/TLS/read is cancellable.

    Private request/response bytes only cross anonymous pipes, never argv, stderr or disk.
    The worker inherits the existing sandbox/process group and has no persistent service.
    """
    if cancel_event and cancel_event.is_set():
        raise TranslationFailure("api_request_cancelled_unknown", {"transportPhase": "before_start"})
    deadline = time.monotonic() + timeout
    process = subprocess.Popen([sys.executable, "-u", str(Path(__file__).with_name("http_worker.py"))],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               bufsize=0)
    try:
        data = json.dumps({"url": url, "key": key, "body": body, "timeout": timeout}).encode()
        pending = memoryview(data)
        while pending:
            pending = pending[process.stdin.write(pending):]
        process.stdin.close()
        buffer = b""
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                # Consume an already completed response before cancelling; preserve its usage.
                ready = selector.select(0)
                if not ready:
                    if cancel_event and cancel_event.is_set():
                        raise TranslationFailure("api_request_cancelled_unknown", {"transportPhase": "http_wait"})
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TranslationFailure("api_request_timed_out_unknown", {"transportPhase": "http_wait", "timeoutKind": "overall"})
                    ready = selector.select(min(.1, remaining))
                    if not ready:
                        continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise TranslationFailure("api_transport_worker_exited", {"transportPhase": "worker_pipe"})
                buffer += chunk
                if len(buffer) > 20 * 1024 * 1024:
                    raise TranslationFailure("api_stream_too_large")
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    event = json.loads(line)
                    if event.get("kind") == "progress":
                        if on_progress:
                            on_progress(event["value"])
                    elif event.get("kind") == "result":
                        return event["status"], event["value"]
                    elif event.get("kind") == "failure":
                        raise TranslationFailure(event["code"], event.get("details", {}))
                    else:
                        raise TranslationFailure("invalid_transport_worker_event")
                if cancel_event and cancel_event.is_set():
                    raise TranslationFailure("api_request_cancelled_unknown", {"transportPhase": "read_stream"})
    except (ValueError, UnicodeError):
        raise TranslationFailure("invalid_transport_worker_event") from None
    except (OSError, BrokenPipeError) as error:
        raise TranslationFailure("api_transport_unknown", transport_error_details(error, "worker_pipe")) from None
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=.5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        process.stdout.close()
        if not process.stdin.closed:
            process.stdin.close()


def transport_error_details(error, phase):
    """Exception names/errno are useful; messages, URLs and arbitrary reasons are private."""
    cause = error.reason if isinstance(error, urllib.error.URLError) else error
    result = {"transportExceptionType": type(error).__name__, "transportPhase": phase}
    if isinstance(cause, BaseException):
        result["transportCauseType"] = type(cause).__name__
        if type(getattr(cause, "errno", None)) is int:
            result["transportErrno"] = cause.errno
        if type(getattr(cause, "verify_code", None)) is int:
            result["tlsVerifyCode"] = cause.verify_code
        if isinstance(cause, TimeoutError):
            result["timeoutKind"] = "connect_or_headers" if phase == "connect_or_headers" else "read"
    return result


def blocking_http_request(url, key, body, timeout, on_progress=None):
    deadline = time.monotonic() + timeout
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json",
        "User-Agent": "Kurumi-Papers/1.0",
    })
    opener = urllib.request.build_opener(NoRedirect())
    phase, status = "connect_or_headers", None
    try:
        with opener.open(request, timeout=timeout) as response:
            status, phase = response.status, "read_stream" if body.get("stream") else "read_body"
            if body.get("stream"):
                try:
                    value = read_response_stream(response, on_progress=on_progress, deadline=deadline)
                except TranslationFailure as error:
                    error.details["httpStatus"] = response.status
                    raise
                return response.status, value
            return response.status, json.loads(response.read(4 * 1024 * 1024))
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read(32768))
        except Exception:
            # An edge/WAF rejection is not evidence that a credential is bad.
            body = {"error": {"code": "non_json_http_error"}}
        return error.code, body
    except TranslationFailure:
        raise
    except (OSError, urllib.error.URLError, http.client.HTTPException) as error:
        # The next independent channel may replay this batch, with unknown usage recorded.
        details = transport_error_details(error, phase)
        if status is not None:
            details["httpStatus"] = status
        code = "api_request_timed_out_unknown" if time.monotonic() >= deadline else "api_transport_unknown"
        raise TranslationFailure(code, details) from None
    except (ValueError, UnicodeError):
        raise TranslationFailure("invalid_api_response") from None


def read_response_stream(response, on_progress=None, deadline=None):
    """Only the terminal Responses object is authoritative; never return partial deltas."""
    size, event, count, output_chars, last_progress = 0, [], 0, 0, 0
    started, last_output = time.monotonic(), None
    while True:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TranslationFailure("api_request_timed_out_unknown")
            # urllib's socket timeout alone is an inactivity limit, not an overall deadline.
            sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
            if sock is not None:
                sock.settimeout(remaining)
        line = response.readline()
        if not line:
            break
        size += len(line)
        if size > 16 * 1024 * 1024 or len(line) > 4 * 1024 * 1024:
            raise TranslationFailure("api_stream_too_large")
        line = line.decode("utf8").rstrip("\r\n")
        if line.startswith("data:"):
            event.append(line[5:].lstrip())
        elif not line and event:
            raw = "\n".join(event); event = []
            if raw == "[DONE]":
                break
            data = json.loads(raw)
            kind = data.get("type")
            count += 1
            if kind == "response.output_text.delta":
                output_chars += len(data.get("delta", ""))
                last_output = time.monotonic() - started
            if on_progress and (time.monotonic() - last_progress >= 5 or
                                kind in ("response.completed", "response.failed", "response.incomplete", "error")):
                on_progress({"events": count, "outputChars": output_chars,
                             "lastEvent": kind if isinstance(kind, str) and re.fullmatch(r"[a-z_.]{1,100}", kind) else "unknown",
                             "lastEventOffsetSeconds": round(time.monotonic() - started, 3),
                             "lastOutputOffsetSeconds": None if last_output is None else round(last_output, 3)})
                last_progress = time.monotonic()
            if kind in ("response.completed", "response.failed", "response.incomplete"):
                value = data.get("response")
                if not isinstance(value, dict):
                    raise TranslationFailure("invalid_api_terminal_event")
                return value
            if kind == "error":
                details = safe_error_details(data)
                if details.get("apiErrorCode") in AUTH_CODES + QUOTA_CODES + ("rate_limit_exceeded",):
                    return {"status": "failed", "error": {"code": details["apiErrorCode"]}}
                raise TranslationFailure("api_stream_error", details)
    raise TranslationFailure("api_stream_interrupted_unknown")


def atomic_json(file, data):
    file = Path(file)
    descriptor, temp = tempfile.mkstemp(prefix=file.name + ".tmp-", dir=file.parent)
    try:
        with os.fdopen(descriptor, "w") as out:
            json.dump(data, out, ensure_ascii=False, indent=2)
        os.replace(temp, file)
    finally:
        Path(temp).unlink(missing_ok=True)


class ResponsesClient:
    """Bounded network concurrency; shared accounting/circuit state stays under a short lock.

    Each caller owns its receipt. Failed/late in-flight calls are accounted even after another
    call stops admissions. Reported tokens stop new attempts, not already billed upstream work.
    """
    def __init__(self, profile, keys, *, max_requests=300, max_tokens=150000,
                 timeout=600, cooldown_file=None, request=http_request, sleep=time.sleep,
                 now=time.time, on_usage=None, max_concurrency=1, max_qps=None,
                 batch_validation_retries=1, channel_recovery_retries=1,
                 channel_cooldown_seconds=300, execution_timeout_seconds=1800):
        spec = registered_profile(profile)
        self.profile, self.key_ids = dict(profile), tuple(spec["credentialIds"])
        self.batch_format = spec["batchFormat"]
        self.keys = {k: keys[k].strip() for k in self.key_ids if isinstance(keys.get(k), str) and keys[k].strip()}
        if not self.keys:
            raise TranslationFailure("missing_translation_credentials")
        if (type(max_concurrency) is not int or not 1 <= max_concurrency <= 4 or
                (max_qps is not None and (type(max_qps) not in (int, float) or not 0 < max_qps <= 100))):
            raise TranslationFailure("invalid_translation_concurrency")
        for value in (batch_validation_retries, channel_recovery_retries):
            if type(value) is not int or not 0 <= value <= 4:
                raise TranslationFailure("invalid_translation_retry_limit")
        self.batch_validation_retries = batch_validation_retries
        self.channel_recovery_retries = channel_recovery_retries
        self.channel_cooldown_seconds = channel_cooldown_seconds
        self.max_requests, self.max_tokens, self.timeout = max_requests, max_tokens, timeout
        self.request, self.sleep, self.now = request, sleep, now
        self.cooldown_file, self.on_usage = cooldown_file, on_usage
        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(max_concurrency)
        self.stopped = threading.Event()
        self.local = threading.local()
        self.max_concurrency, self.max_qps = max_concurrency, max_qps
        self.in_flight = self.peak_in_flight = 0
        self.started_clock = time.monotonic()
        self.deadline = self.started_clock + execution_timeout_seconds
        self.next_start = self.started_clock
        self.requests = 0
        self.input_tokens = self.output_tokens = 0
        self.receipts = []
        self.failure = None
        self.failure_details = {}
        self.failure_clock = None
        self.batch_count = 0
        self.validation_failure = None
        self.normalized_json_fences = 0
        self.recovery_waits = []
        self.probing = {}
        self.cooldowns = {}
        if cooldown_file and Path(cooldown_file).exists():
            raw = json.loads(Path(cooldown_file).read_text())
            # Old files contain only expiry numbers. Preserve those expiries exactly.
            self.cooldowns = {k: ({"until": v, "recoverable": v - self.now() <= 300,
                                   "reason": "legacy_cooldown"} if type(v) in (int, float) else v)
                              for k, v in raw.items()}

    def snapshot(self):
        with self.lock:
            return {"requests": self.requests, "inputTokens": self.input_tokens,
                    "outputTokens": self.output_tokens, "reportedTokens": self.input_tokens + self.output_tokens,
                    "receipts": copy.deepcopy(self.receipts), "failure": self.failure,
                    "failureDetails": copy.deepcopy(self.failure_details),
                    "failureDetectedOffsetSeconds": self.failure_clock,
                    "maxRequests": self.max_requests, "maxReportedTokens": self.max_tokens,
                    "validationFailure": copy.deepcopy(self.validation_failure),
                    "normalizedJsonFences": self.normalized_json_fences,
                    "batchValidationRetries": self.batch_validation_retries,
                    "validationFailures": sum("validationFailure" in r for r in self.receipts),
                    "validationRetriesScheduled": sum(r.get("validationRetryScheduled", False) for r in self.receipts),
                    "channelRecoveryRetries": self.channel_recovery_retries,
                    "recoveryWaits": copy.deepcopy(self.recovery_waits),
                    "unknownUsageAttempts": sum(r.get("usageStatus") == "unknown" for r in self.receipts),
                    "channelFailures": sum(r.get("outcome") == "channel_failed" for r in self.receipts),
                    "maxConcurrency": self.max_concurrency, "maxQps": self.max_qps,
                    "inFlight": self.in_flight, "peakInFlight": self.peak_in_flight,
                    "hardCostLimit": False}

    def _publish(self):
        # Serialize snapshot + write: an older concurrent snapshot must not overwrite a newer one.
        with self.lock:
            if self.on_usage:
                self.on_usage(self.snapshot())

    def fail(self, code, *, details=None, validation=None, annotate=True):
        with self.lock:
            receipt = getattr(self.local, "receipt", None) if annotate else None
            if receipt is not None:
                if details: receipt.update(details)
                receipt["error"] = code
                if validation is not None: receipt["validationFailure"] = copy.deepcopy(validation)
            if self.failure is None:
                self.failure = code
                self.failure_details = copy.deepcopy(details or {})
                self.failure_clock = round(time.monotonic() - self.started_clock, 6)
                self.validation_failure = copy.deepcopy(validation)
            self.stopped.set()
            self._publish()

    def normalize_json_fence(self):
        with self.lock:
            self.normalized_json_fences += 1
            self._publish()

    def record_validation_failure(self, validation, *, retry, allowed, code="invalid_batch_translation"):
        with self.lock:
            receipt = getattr(self.local, "receipt", None)
            if receipt is not None:
                receipt.update(error=code, outcome="validation_failed",
                               validationFailure=copy.deepcopy(validation), validationAttempt=retry + 1,
                               validationRetriesAllowed=allowed, validationRetryScheduled=retry < allowed)
            self._publish()

    @contextlib.contextmanager
    def batch_context(self):
        previous = getattr(self.local, "batch", None)
        with self.lock:
            self.batch_count += 1
            context = {"id": self.batch_count, "attempt": 0}
        self.local.batch = context
        try:
            yield context
        finally:
            self.local.batch = previous

    def _assert_budget(self):
        exhausted = ("requests" if self.requests >= self.max_requests else
                     "reported_tokens" if self.input_tokens + self.output_tokens >= self.max_tokens else None)
        if exhausted:
            self.fail("translation_budget_exhausted", details={"budgetExhaustedBy": exhausted}, annotate=False)
            raise TranslationFailure("translation_budget_exhausted")

    def _cool_key(self, name):
        return name + ":" + hashlib.sha256(self.keys[name].encode()).hexdigest()[:16]

    def _cool(self, name, seconds, *, reason="credential_unavailable", recoverable=False):
        # Called while the accounting lock is held; keep the longest active cooldown.
        key = self._cool_key(name)
        previous = self.cooldowns.get(key, {})
        until = self.now() + seconds
        if previous.get("until", 0) <= until:
            self.cooldowns[key] = {"until": until, "reason": reason, "recoverable": recoverable}
        if self.cooldown_file:
            atomic_json(self.cooldown_file, self.cooldowns)

    def _channel_failed(self, name, receipt, code):
        receipt.update(outcome="channel_failed", failoverReason=code)
        self._cool(name, self.channel_cooldown_seconds, reason=code, recoverable=True)
        self._publish()

    def generate(self, text, instructions, *, preserve_placeholders=False, output_format=None):
        if getattr(self.local, "batch", None) is None:
            with self.batch_context():
                return self.generate(text, instructions, preserve_placeholders=preserve_placeholders, output_format=output_format)
        self.local.receipt = None
        while not self.slots.acquire(timeout=0.05):
            if self.stopped.is_set():
                raise TranslationFailure(self.failure)
        try:
            with self.lock:
                if self.failure:
                    raise TranslationFailure(self.failure)
            for attempt in range((self.batch_validation_retries if preserve_placeholders else 0) + 1):
                if preserve_placeholders:
                    self.local.batch["attempt"] = attempt
                value = self._generate(text, instructions, False, output_format)
                if not preserve_placeholders or placeholders(text) == placeholders(value):
                    return value
                validation = marker_validation(text, value)
                self.record_validation_failure(validation, retry=attempt, allowed=self.batch_validation_retries,
                                               code="translation_placeholder_mismatch")
                if attempt == self.batch_validation_retries:
                    self.fail("translation_placeholder_mismatch", validation=validation)
                    raise TranslationFailure("translation_placeholder_mismatch")
                instructions += validation_retry_hint(validation)
        except TranslationFailure as error:
            with self.lock:
                if self.failure is None:
                    self.fail(str(error), details=error.details)
            raise
        except Exception:
            self.fail("invalid_api_response")
            raise TranslationFailure("invalid_api_response") from None
        finally:
            self.slots.release()

    def _admit(self, name, text, output_format):
        while True:
            with self.lock:
                if self.failure:
                    raise TranslationFailure(self.failure)
                if name not in self.keys:
                    return None
                cooldown = self.cooldowns.get(self._cool_key(name), {})
                if cooldown.get("until", 0) > self.now() or name in self.probing:
                    return None
                if time.monotonic() >= self.deadline:
                    self.fail("translation_timed_out", annotate=False)
                    raise TranslationFailure("translation_timed_out")
                self._assert_budget()
                clock = time.monotonic()
                delay = self.next_start - clock if self.max_qps else 0
                if delay <= 0:
                    if self.max_qps: self.next_start = clock + 1 / self.max_qps
                    self.requests += 1
                    self.in_flight += 1
                    self.peak_in_flight = max(self.peak_in_flight, self.in_flight)
                    receipt = {"attempt": self.requests, "credentialId": name,
                               "batchId": self.local.batch["id"],
                               "validationAttempt": self.local.batch["attempt"] + 1,
                               "provider": self.profile["provider"], "channel": self.profile["channel"],
                               "model": self.profile["model"], "effort": self.profile["effort"],
                               "inputChars": len(text), "stream": True,
                               "outputFormat": "text" if output_format is None else output_format.get("type"),
                               "usageStatus": "unknown", "startedOffsetSeconds": round(clock - self.started_clock, 6),
                               "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                    receipt["recoveryRound"] = getattr(self.local, "recovery_round", 0)
                    if cooldown.get("recoverable"):
                        # One half-open probe per recovering channel; other callers keep waiting.
                        self.probing[name] = receipt
                        receipt["recoveryProbe"] = True
                        receipt["cooldownUntil"] = cooldown["until"]
                    self.receipts.append(receipt)
                    self.local.receipt = receipt
                    self._publish()
                    return receipt
            # Neither the accounting lock nor another channel's network work waits on this timer.
            if self.stopped.wait(delay):
                raise TranslationFailure(self.failure)

    def _generate(self, text, instructions, preserve_placeholders, output_format):
        if not isinstance(text, str) or not text.strip():
            raise TranslationFailure("invalid_translation_input")
        body = {"model": self.profile["model"], "reasoning": {"effort": self.profile["effort"]},
                "instructions": instructions, "input": text, "store": False,
                "max_output_tokens": 8192, "stream": True}
        if output_format is not None:
            body["text"] = {"format": output_format}
        channel_failed = False
        recovery_round = 0
        attempted = set()
        recovery_deadline = None
        while True:
            self.local.recovery_round = recovery_round
            result, failed = self._generate_cycle(text, body, preserve_placeholders, output_format, attempted)
            channel_failed = channel_failed or failed
            if result is not None:
                return result
            if self._await_probes(attempted):
                # Another caller owns the half-open request; its result is not our retry.
                continue
            if recovery_round and self._wait_for_recovery(recovery_round, attempted, recovery_deadline):
                # A round includes every channel, including ones whose cooldown expires later.
                # Never repeat a failed channel just because it cooled again while we waited.
                continue
            if recovery_round >= self.channel_recovery_retries:
                break
            recovery_round += 1
            attempted = set()
            recovery_deadline = min(self.deadline, time.monotonic() + 330)
            if not self._wait_for_recovery(recovery_round, attempted, recovery_deadline):
                break
        code = "all_translation_channels_failed" if channel_failed else "all_translation_credentials_unavailable"
        self.fail(code, annotate=False)
        raise TranslationFailure(code)

    def _await_probes(self, excluded):
        observed = False
        while True:
            with self.lock:
                if self.failure:
                    raise TranslationFailure(self.failure)
                if not any(name not in excluded for name in self.probing):
                    return observed and any(name not in excluded and name in self.keys and
                        self.cooldowns.get(self._cool_key(name), {}).get("until", 0) <= self.now()
                        for name in self.key_ids)
                observed = True
                if time.monotonic() >= self.deadline:
                    self.fail("translation_timed_out", annotate=False)
                    raise TranslationFailure("translation_timed_out")
            if self.stopped.wait(.05):
                raise TranslationFailure(self.failure)

    def _wait_for_recovery(self, recovery_round, excluded, wait_deadline):
        # Bounds apply to every caller, including a task that starts with inherited cooldowns.
        started = time.monotonic()
        record = None
        while True:
            with self.lock:
                if self.failure:
                    raise TranslationFailure(self.failure)
                self._assert_budget()
                if time.monotonic() >= self.deadline:
                    self.fail("translation_timed_out", annotate=False)
                    raise TranslationFailure("translation_timed_out")
                candidates = []
                for name in self.key_ids:
                    if name in excluded or name not in self.keys:
                        continue
                    cooldown = self.cooldowns.get(self._cool_key(name), {})
                    if not cooldown or (cooldown.get("until", 0) <= self.now() and name not in self.probing):
                        if record is not None:
                            record.update(elapsedSeconds=round(time.monotonic() - started, 3), outcome="ready")
                            self._publish()
                        return True
                    if cooldown.get("recoverable"):
                        candidates.append((max(0, cooldown["until"] - self.now()), name))
                if not candidates or time.monotonic() >= wait_deadline:
                    if record is not None:
                        record.update(elapsedSeconds=round(time.monotonic() - started, 3), outcome="exhausted")
                        self._publish()
                    return False
                delay, name = min(candidates)
                if delay > wait_deadline - time.monotonic():
                    return False
                if record is None:
                    record = {"round": recovery_round, "credentialId": name, "batchId": self.local.batch["id"],
                              "scheduledWaitSeconds": round(delay, 3), "outcome": "waiting"}
                    self.recovery_waits.append(record)
                    self._publish()
            if self.stopped.wait(min(.1, max(.01, delay))):
                raise TranslationFailure(self.failure)

    def _generate_cycle(self, text, body, preserve_placeholders, output_format, attempted):
        channel_failed = False
        for name in self.key_ids:
            if name in attempted:
                continue
            for attempt in range(2):
                self.local.receipt = None
                receipt = self._admit(name, text, output_format)
                if receipt is None:
                    break
                attempted.add(name)
                options = {}
                if self.request is http_request:
                    def progress(value):
                        with self.lock:
                            receipt["streamProgress"] = value
                            self._publish()
                    options["on_progress"] = progress
                    options["cancel_event"] = self.stopped
                started = time.monotonic()
                transport_error = None
                try:
                    status, data = self.request(self.profile["baseUrl"] + "/responses", self.keys[name], body, self.timeout, **options)
                except TranslationFailure as error:
                    transport_error = error
                except Exception:
                    transport_error = TranslationFailure("invalid_api_response")
                with self.lock:
                    # Always account completed in-flight responses, even after another call failed.
                    self.in_flight -= 1
                    receipt["elapsedSeconds"] = round(time.monotonic() - started, 3)
                    receipt["finishedOffsetSeconds"] = round(time.monotonic() - self.started_clock, 6)
                    probe = self.probing.get(name) is receipt
                    if probe:
                        del self.probing[name]
                    try:
                        if transport_error is not None:
                            receipt.update(transport_error.details)
                            receipt["error"] = str(transport_error)
                            if str(transport_error) == "api_request_cancelled_unknown":
                                receipt["outcome"] = "cancelled"
                                if self.failure_clock is not None:
                                    receipt["cancellationDelaySeconds"] = round(receipt["finishedOffsetSeconds"] - self.failure_clock, 6)
                                self._publish()
                                raise TranslationFailure(self.failure or "translation_cancelled")
                            retryable = (str(transport_error) in CHANNEL_FAILURES or
                                (str(transport_error) == "api_stream_error" and transport_error.details.get("apiErrorCode") in CHANNEL_ERROR_CODES))
                            if retryable:
                                self._channel_failed(name, receipt, transport_error.details.get("apiErrorCode", str(transport_error)))
                                action, value = "next", None
                            else:
                                raise transport_error
                        else:
                            action, value = self._complete_reply(name, receipt, status, data, text, preserve_placeholders, attempt)
                            if action == "result" and probe:
                                key = self._cool_key(name)
                                if self.cooldowns.get(key, {}).get("until") == receipt.get("cooldownUntil"):
                                    del self.cooldowns[key]
                                    if self.cooldown_file:
                                        atomic_json(self.cooldown_file, self.cooldowns)
                    except TranslationFailure as error:
                        # Mark terminal failure before another caller can admit a new paid request.
                        if self.failure is None:
                            self.fail(str(error), details=error.details)
                        else:
                            self._publish()
                        raise
                    except Exception:
                        self.fail("invalid_api_response")
                        raise TranslationFailure("invalid_api_response") from None
                if action == "result":
                    return value, channel_failed
                if action == "retry":
                    if self.sleep is time.sleep:
                        if self.stopped.wait(1):
                            raise TranslationFailure(self.failure)
                    else:
                        self.sleep(1)  # Injectable offline clock; production backoff is cancellable.
                    continue
                channel_failed = channel_failed or receipt.get("outcome") == "channel_failed"
                break
        return None, channel_failed

    def _complete_reply(self, name, receipt, status, data, text, preserve_placeholders, attempt):
        receipt["httpStatus"] = status
        if isinstance(data, dict) and isinstance(data.get("usage"), dict):
            usage = data["usage"]
            inp, out = usage.get("input_tokens"), usage.get("output_tokens")
            if type(inp) is int and type(out) is int and inp >= 0 and out >= 0:
                self.input_tokens += inp
                self.output_tokens += out
                receipt["usage"] = {k: usage[k] for k in ("input_tokens", "output_tokens", "input_tokens_details", "output_tokens_details") if k in usage}
                receipt["usageStatus"] = "reported"
        if isinstance(data, dict) and isinstance(data.get("id"), str):
            receipt["responseId"] = data["id"][:150]
        error_code = (data.get("error") or {}).get("code", "") if isinstance(data, dict) and isinstance(data.get("error", {}), dict) else ""
        if isinstance(error_code, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", error_code):
            receipt["apiErrorCode"] = error_code
        if isinstance(data, dict) and isinstance(data.get("error"), dict):
            receipt.update(safe_error_details(data))
        if isinstance(data, dict) and isinstance(data.get("reasoning"), dict):
            receipt["responseEffort"] = data["reasoning"].get("effort")
        self._publish()
        effective_status = status
        if status == 200 and isinstance(data, dict) and data.get("status") == "failed":
            if error_code in AUTH_CODES: effective_status = 401
            elif error_code in QUOTA_CODES + ("rate_limit_exceeded",): effective_status = 429
        if effective_status == 401 or (effective_status == 403 and error_code in AUTH_CODES):
            receipt.update(outcome="credential_rejected", usageStatus="reported" if "usage" in receipt else "not_reported_on_rejection")
            self._cool(name, 86400, reason=error_code or "authentication_rejected")
            self._publish()
            return "next", None
        if effective_status == 429:
            receipt.update(outcome="quota_or_rate_limit", usageStatus="reported" if "usage" in receipt else "not_reported_on_rejection")
            if error_code not in QUOTA_CODES and attempt == 0:
                self._publish()
                return "retry", None
            self._cool(name, 120, reason=error_code or "rate_limit_exceeded", recoverable=True)
            self._publish()
            return "next", None
        if (status in CHANNEL_HTTP_STATUSES or
            (status == 200 and isinstance(data, dict) and data.get("status") == "failed" and error_code in CHANNEL_ERROR_CODES)):
            self._channel_failed(name, receipt, error_code or "responses_http_" + str(status))
            return "next", None
        if status != 200:
            receipt["outcome"] = "request_rejected"
            raise TranslationFailure("responses_http_" + str(status))
        if "usage" not in receipt:
            raise TranslationFailure("api_usage_unknown")
        if data.get("model") != self.profile["model"]:
            raise TranslationFailure("api_model_mismatch")
        if receipt.get("responseEffort") not in (None, self.profile["effort"]):
            raise TranslationFailure("api_effort_mismatch")
        if data.get("status") != "completed":
            raise TranslationFailure("response_not_completed")
        chunks = []
        for item in data.get("output", []):
            if item.get("type") != "message" or item.get("role") != "assistant":
                continue
            for content in item.get("content", []):
                if content.get("type") == "refusal":
                    raise TranslationFailure("translation_refused")
                if content.get("type") == "output_text":
                    chunks.append(content.get("text", ""))
        result = "".join(chunks).strip()
        if not result:
            raise TranslationFailure("empty_translation")
        if preserve_placeholders and placeholders(text) != placeholders(result):
            raise TranslationFailure("translation_placeholder_mismatch")
        receipt["outcome"] = "completed"
        self._publish()
        return "result", result
