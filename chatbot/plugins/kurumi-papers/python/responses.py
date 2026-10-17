"""Native Responses transport, bounded retries and shared credential cooldown. Contract: docs/22.

Standard library only, so tests can inject an HTTP transport without a model or Python PDF runtime.
No SDK retries, upstream Chat calls or upstream translator health-check requests are used.
"""
import collections
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import threading
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
                       "gateway_timeout")
CHANNEL_HTTP_STATUSES = (408, 500, 502, 503, 504, 520, 522, 524, 529)
CHANNEL_FAILURES = ("api_transport_unknown", "api_request_timed_out_unknown",
                    "api_stream_interrupted_unknown")


def placeholders(text):
    return collections.Counter(re.findall(r"\{v\d+\}|</?b\d+>|<style\s+id=['\"]\d+['\"]>|</style>", text))


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


def http_request(url, key, body, timeout, on_progress=None):
    deadline = time.monotonic() + timeout
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json",
        "User-Agent": "Kurumi-Papers/1.0",
    })
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
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
    except (OSError, urllib.error.URLError, http.client.HTTPException):
        # The next independent channel may replay this batch, with unknown usage recorded.
        raise TranslationFailure("api_transport_unknown") from None
    except (ValueError, UnicodeError):
        raise TranslationFailure("invalid_api_response") from None


def read_response_stream(response, on_progress=None, deadline=None):
    """Only the terminal Responses object is authoritative; never return partial deltas."""
    size, event, count, output_chars, last_progress = 0, [], 0, 0, 0
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
            if on_progress and time.monotonic() - last_progress >= 5:
                on_progress({"events": count, "outputChars": output_chars,
                             "lastEvent": kind if isinstance(kind, str) and re.fullmatch(r"[a-z_.]{1,100}", kind) else "unknown"})
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
    temp = file.with_name(file.name + ".tmp-" + str(os.getpid()))
    with open(temp, "w", opener=lambda p, f: os.open(p, f, 0o600)) as out:
        json.dump(data, out, ensure_ascii=False, indent=2)
    os.replace(temp, file)


class ResponsesClient:
    def __init__(self, profile, keys, *, max_requests=200, max_tokens=150000,
                 timeout=600, cooldown_file=None, request=http_request, sleep=time.sleep,
                 now=time.time, on_usage=None):
        spec = registered_profile(profile)
        self.profile, self.key_ids = dict(profile), tuple(spec["credentialIds"])
        self.batch_format = spec["batchFormat"]
        self.keys = {k: keys[k].strip() for k in self.key_ids if isinstance(keys.get(k), str) and keys[k].strip()}
        if not self.keys:
            raise TranslationFailure("missing_translation_credentials")
        self.max_requests, self.max_tokens, self.timeout = max_requests, max_tokens, timeout
        self.request, self.sleep, self.now = request, sleep, now
        self.cooldown_file, self.on_usage = cooldown_file, on_usage
        self.lock = threading.RLock()
        self.requests = 0
        self.input_tokens = self.output_tokens = 0
        self.receipts = []
        self.failure = None
        self.validation_failure = None
        self.normalized_json_fences = 0
        self.cooldowns = {}
        if cooldown_file and Path(cooldown_file).exists():
            self.cooldowns = json.loads(Path(cooldown_file).read_text())

    def snapshot(self):
        return {"requests": self.requests, "inputTokens": self.input_tokens,
                "outputTokens": self.output_tokens, "reportedTokens": self.input_tokens + self.output_tokens,
                "receipts": list(self.receipts), "failure": self.failure,
                "validationFailure": self.validation_failure,
                "normalizedJsonFences": self.normalized_json_fences,
                "unknownUsageAttempts": sum(r.get("usageStatus") == "unknown" for r in self.receipts),
                "channelFailures": sum(r.get("outcome") == "channel_failed" for r in self.receipts),
                "hardCostLimit": False}

    def _publish(self):
        if self.on_usage:
            self.on_usage(self.snapshot())

    def _cool_key(self, name):
        return name + ":" + hashlib.sha256(self.keys[name].encode()).hexdigest()[:16]

    def _cool(self, name, seconds):
        self.cooldowns[self._cool_key(name)] = self.now() + seconds
        if self.cooldown_file:
            atomic_json(self.cooldown_file, self.cooldowns)

    def _channel_failed(self, name, receipt, code):
        receipt.update(outcome="channel_failed", failoverReason=code)
        self._cool(name, 300)
        self._publish()

    def generate(self, text, instructions, *, preserve_placeholders=False, output_format=None):
        with self.lock:
            if self.failure:
                raise TranslationFailure(self.failure)
            try:
                return self._generate(text, instructions, preserve_placeholders, output_format)
            except TranslationFailure as error:
                self.failure = str(error)
                if self.receipts:
                    self.receipts[-1].update(error.details)
                self._publish()
                raise
            except Exception:
                self.failure = "invalid_api_response"
                self._publish()
                raise TranslationFailure(self.failure) from None

    def _generate(self, text, instructions, preserve_placeholders, output_format):
        if not isinstance(text, str) or not text.strip():
            raise TranslationFailure("invalid_translation_input")
        # Every segment starts a fresh request: no previous_response_id or accumulating history.
        body = {"model": self.profile["model"], "reasoning": {"effort": self.profile["effort"]},
                "instructions": instructions, "input": text, "store": False,
                "max_output_tokens": 8192, "stream": True}
        if output_format is not None:
            body["text"] = {"format": output_format}
        for name in self.key_ids:
            if name not in self.keys or self.cooldowns.get(self._cool_key(name), 0) > self.now():
                continue
            for attempt in range(2):
                if self.requests >= self.max_requests or self.input_tokens + self.output_tokens >= self.max_tokens:
                    raise TranslationFailure("translation_budget_exhausted")
                self.requests += 1
                receipt = {"attempt": self.requests, "credentialId": name,
                           "provider": self.profile["provider"], "channel": self.profile["channel"],
                           "model": self.profile["model"], "effort": self.profile["effort"],
                           "inputChars": len(text), "stream": True,
                           "outputFormat": "text" if output_format is None else output_format.get("type"),
                           "usageStatus": "unknown",
                           "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                self.receipts.append(receipt)
                self._publish()  # A killed/incomplete call is visible as an attempt with unknown usage.
                options = {}
                if self.request is http_request:
                    def progress(value):
                        receipt["streamProgress"] = value
                        self._publish()
                    options["on_progress"] = progress
                started = time.monotonic()
                try:
                    try:
                        status, data = self.request(self.profile["baseUrl"] + "/responses", self.keys[name], body, self.timeout, **options)
                    finally:
                        receipt["elapsedSeconds"] = round(time.monotonic() - started, 3)
                except TranslationFailure as error:
                    receipt.update(error.details)
                    receipt["error"] = str(error)
                    retryable = (str(error) in CHANNEL_FAILURES or
                        (str(error) == "api_stream_error" and error.details.get("apiErrorCode") in CHANNEL_ERROR_CODES))
                    if retryable:
                        self._channel_failed(name, receipt, error.details.get("apiErrorCode", str(error)))
                        break
                    self._publish()
                    raise
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
                self._publish()
                error_code = (data.get("error") or {}).get("code", "") if isinstance(data, dict) and isinstance(data.get("error", {}), dict) else ""
                if isinstance(error_code, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", error_code):
                    receipt["apiErrorCode"] = error_code
                if isinstance(data, dict) and isinstance(data.get("error"), dict):
                    for field in ("type", "param"):
                        value = data["error"].get(field)
                        if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_.\[\]-]{1,100}", value):
                            receipt["apiError" + field.title()] = value
                if isinstance(data, dict) and isinstance(data.get("reasoning"), dict):
                    receipt["responseEffort"] = data["reasoning"].get("effort")
                self._publish()
                # Some Responses relays send explicit auth/quota errors inside an HTTP 200 stream.
                effective_status = status
                if status == 200 and data.get("status") == "failed":
                    if error_code in AUTH_CODES: effective_status = 401
                    elif error_code in QUOTA_CODES + ("rate_limit_exceeded",): effective_status = 429
                if effective_status == 401 or (effective_status == 403 and error_code in AUTH_CODES):
                    receipt.update(outcome="credential_rejected", usageStatus="reported" if "usage" in receipt else "not_reported_on_rejection")
                    self._cool(name, 86400)
                    self._publish()
                    break
                if effective_status == 429:
                    receipt.update(outcome="quota_or_rate_limit", usageStatus="reported" if "usage" in receipt else "not_reported_on_rejection")
                    code = error_code
                    if code not in QUOTA_CODES and attempt == 0:
                        self._publish()
                        self.sleep(1)
                        continue
                    self._cool(name, 120)
                    self._publish()
                    break
                if (status in CHANNEL_HTTP_STATUSES or
                    (status == 200 and data.get("status") == "failed" and error_code in CHANNEL_ERROR_CODES)):
                    self._channel_failed(name, receipt, error_code or "responses_http_" + str(status))
                    break
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
                if preserve_placeholders:
                    if placeholders(text) != placeholders(result):
                        raise TranslationFailure("translation_placeholder_mismatch")
                receipt["outcome"] = "completed"
                self._publish()
                return result
        if any(r.get("outcome") == "channel_failed" for r in self.receipts):
            raise TranslationFailure("all_translation_channels_failed")
        raise TranslationFailure("all_translation_credentials_unavailable")
