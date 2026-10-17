"""Offline batch/recovery/cancellation regressions. Synthetic data and local HTTP only.

Development owner: docs/22_论文PDF翻译与文件投递.md. No paid API, credentials,
production state or deliveries. Local subprocess/HTTP checks exercise the actual transport.
"""
import concurrent.futures
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "plugins/kurumi-papers/python"))
from engine import translate_batch
from responses import (ResponsesClient, TranslationFailure, KEY_IDS, http_request,
                       blocking_http_request, read_response_stream, transport_error_details)

PROFILE = {"provider": "openai", "channel": "naiccc", "model": "gpt-6.1-sol", "effort": "high",
           "protocol": "responses", "baseUrl": "https://naiccc.com/v1"}
KEYS = dict(zip(KEY_IDS, ("synthetic-014", "synthetic-030", "synthetic-040")))
SOURCE = [{"id": 7, "input": "Synthetic formula {v1}"}, {"id": 8, "input": "Other paragraph"}]
PROMPT = "## Here is the input:\n" + json.dumps(SOURCE)
VALID = json.dumps([{"id": 7, "output": "合成公式 {v1}"}, {"id": 8, "output": "另一段"}])
INVALID = json.dumps([{"id": 7, "output": "丢失公式"}, {"id": 8, "output": "另一段"}])


def completed(text="ok"):
    return 200, {"status": "completed", "model": PROFILE["model"], "reasoning": {"effort": "high"},
                 "usage": {"input_tokens": 3, "output_tokens": 5}, "output": [{"type": "message",
                 "role": "assistant", "content": [{"type": "output_text", "text": text}]}]}


@contextlib.contextmanager
def local_server():
    ready, release = threading.Event(), threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            try:
                if self.path == "/headers":
                    ready.set()
                    release.wait(4)
                    return
                if body.get("input") == "bad":
                    if not ready.wait(3):
                        return
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error":{"code":"bad_request","message":"PRIVATE"}}')
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b'data: {"type":"response.created"}\n\n')
                self.wfile.flush()
                ready.set()
                if self.path != "/ok":
                    release.wait(4)
                _, result = completed("正文")
                event = {"type": "response.completed", "response": result}
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=.02), daemon=True)
    worker.start()
    try:
        yield "http://127.0.0.1:" + str(server.server_port), ready, release
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        worker.join(1)


class ReliabilityTest(unittest.TestCase):
    def test_default_retries_exact_same_batch_once_and_accounts_both_attempts(self):
        seen = []
        def request(url, key, body, timeout):
            seen.append(body)
            return completed(INVALID if len(seen) == 1 else VALID)
        client = ResponsesClient(PROFILE, KEYS, request=request)
        self.assertEqual(json.loads(translate_batch(client, PROMPT, "en", "zh")), json.loads(VALID))
        self.assertEqual(len(seen), 2)
        self.assertEqual([json.loads(body["input"]) for body in seen], [SOURCE, SOURCE])
        self.assertEqual([body["reasoning"]["effort"] for body in seen], ["high", "high"])
        self.assertNotIn("丢失公式", seen[1]["instructions"])
        self.assertIn('"expectedMarkers": {"{v1}": 1}', seen[1]['instructions'])
        self.assertIn('"missingMarkers": {"{v1}": 1}', seen[1]['instructions'])
        self.assertIn('"itemIndex": 0', seen[1]['instructions'])
        usage = client.snapshot()
        self.assertIsNone(client.failure)
        self.assertEqual((usage["requests"], usage["reportedTokens"], usage["validationFailures"]), (2, 16, 1))
        self.assertTrue(usage["receipts"][0]["validationRetryScheduled"])
        self.assertEqual([r['batchId'] for r in usage['receipts']], [1, 1])
        self.assertEqual([r['validationAttempt'] for r in usage['receipts']], [1, 2])
        self.assertNotIn("Synthetic formula", json.dumps(usage))

    def test_retry_limit_zero_through_four_is_exact_and_exhaustion_stays_terminal(self):
        for retries in range(5):
            with self.subTest(retries=retries):
                client = ResponsesClient(PROFILE, KEYS, request=lambda *args: completed(INVALID),
                                         batch_validation_retries=retries)
                with self.assertRaisesRegex(TranslationFailure, "invalid_batch_translation"):
                    translate_batch(client, PROMPT, "en", "zh")
                self.assertEqual(client.requests, retries + 1)
                self.assertEqual(client.validation_failure["reason"], "placeholder_mismatch")
                self.assertEqual(client.snapshot()["validationRetriesScheduled"], retries)
                with self.assertRaises(TranslationFailure):
                    client.generate("another", "i")
                self.assertEqual(client.requests, retries + 1)

    def test_each_configured_final_retry_can_succeed_without_stopping_other_batches(self):
        for retries in range(1, 5):
            count = 0
            def request(*args):
                nonlocal count
                count += 1
                return completed(VALID if count > retries else INVALID)
            client = ResponsesClient(PROFILE, KEYS, request=request, batch_validation_retries=retries)
            translate_batch(client, PROMPT, "en", "zh")
            self.assertEqual(count, retries + 1)
            self.assertIsNone(client.failure)

    def test_repeated_style_marker_retry_gets_counts_without_echoing_invalid_output_or_prose(self):
        source = [{'id': 4, 'input': "PRIVATE_SOURCE <style id='0'>a</style><style id='1'>b</style>{v2}"}]
        bad = json.dumps([{'id': 4, 'output': "PRIVATE_BAD <style id='0'>甲</style><style id='1'>乙{v3}"}])
        valid = json.dumps([{'id': 4, 'output': "<style id='0'>甲</style><style id='1'>乙</style>{v2}"}])
        seen = []
        def request(url, key, body, *args):
            seen.append(body)
            return completed(bad if len(seen) == 1 else valid)
        client = ResponsesClient(PROFILE, KEYS, request=request)
        translated = translate_batch(client, '## Here is the input:\n'+json.dumps(source), 'en', 'zh')
        self.assertEqual(json.loads(translated), json.loads(valid))
        diagnostic = client.receipts[0]['validationFailure']
        self.assertEqual(diagnostic['missingMarkers'], {'</style>': 1, '{v2}': 1})
        self.assertEqual(diagnostic['extraMarkers'], {'{v3}': 1})
        self.assertEqual(diagnostic['expectedMarkers']['</style>'], 2)
        self.assertNotIn('PRIVATE_', json.dumps(diagnostic))
        self.assertNotIn('PRIVATE_', seen[1]['instructions'])

    def test_ids_counts_json_and_boolean_id_mismatch_share_the_same_bounded_retry(self):
        for bad in ("not-json", "[]", '[{"id":7,"output":"a"}]',
                    '[{"id":true,"output":"a"},{"id":8,"output":"b"}]',
                    '[{"id":7,"output":"a","extra":1},{"id":8,"output":"b"}]'):
            responses = iter((bad, VALID))
            client = ResponsesClient(PROFILE, KEYS, request=lambda *a: completed(next(responses)))
            self.assertEqual(json.loads(translate_batch(client, PROMPT, "en", "zh")), json.loads(VALID))
            self.assertEqual(client.requests, 2)

    def test_single_paragraph_marker_validation_also_has_only_one_retry(self):
        responses = iter(("丢失", "译文 {v1}"))
        client = ResponsesClient(PROFILE, KEYS, request=lambda *a: completed(next(responses)))
        self.assertEqual(client.generate("text {v1}", "i", preserve_placeholders=True), "译文 {v1}")
        self.assertEqual(client.requests, 2)
        self.assertIsNone(client.failure)

    def test_a_retrying_batch_does_not_stop_or_retranslate_a_concurrent_good_batch(self):
        retrying, release = threading.Event(), threading.Event()
        bad_calls = good_calls = 0
        def request(url, key, body, timeout):
            nonlocal bad_calls, good_calls
            source = json.loads(body['input'])
            if source[0]['id'] == 7:
                bad_calls += 1
                if bad_calls == 1:
                    return completed(INVALID)
                retrying.set()
                if not release.wait(2):
                    raise AssertionError('retry gate timeout')
                return completed(VALID)
            good_calls += 1
            return completed('[{"id":99,"output":"独立成功项"}]')
        client = ResponsesClient(PROFILE, KEYS, request=request, max_concurrency=4)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            bad = pool.submit(translate_batch, client, PROMPT, 'en', 'zh')
            try:
                self.assertTrue(retrying.wait(1))
                good_prompt = '## Here is the input:\n'+json.dumps([{'id':99,'input':'Independent'}])
                good = pool.submit(translate_batch, client, good_prompt, 'en', 'zh')
                self.assertEqual(json.loads(good.result(1)), [{'id':99,'output':'独立成功项'}])
                self.assertIsNone(client.failure)
            finally:
                release.set()
            bad.result(1)
        self.assertEqual((bad_calls, good_calls, client.requests), (2, 1, 3))

    def test_validation_retry_cannot_exceed_request_or_token_budget(self):
        for limit in ({"max_requests": 1}, {"max_tokens": 8}):
            client = ResponsesClient(PROFILE, KEYS, request=lambda *a: completed(INVALID), **limit)
            with self.assertRaisesRegex(TranslationFailure, "translation_budget_exhausted"):
                translate_batch(client, PROMPT, "en", "zh")
            self.assertEqual(client.requests, 1)
            self.assertEqual(client.snapshot()['failureDetails']['budgetExhaustedBy'],
                             'requests' if 'max_requests' in limit else 'reported_tokens')

    def test_all_channels_recover_after_cooldown_and_preserve_order_and_usage(self):
        used = []
        def request(url, key, *args):
            used.append(key)
            return (503, {}) if len(used) <= 3 else completed()
        client = ResponsesClient(PROFILE, KEYS, request=request, channel_cooldown_seconds=.04)
        self.assertEqual(client.generate("x", "i"), "ok")
        self.assertEqual(used, [*KEYS.values(), KEYS[KEY_IDS[0]]])
        self.assertEqual(client.receipts[-1]["recoveryRound"], 1)
        self.assertTrue(client.receipts[-1]["recoveryProbe"])
        self.assertEqual(client.snapshot()["unknownUsageAttempts"], 3)
        self.assertEqual(client.snapshot()["recoveryWaits"][0]["outcome"], "ready")

    def test_exhausted_channel_recovery_is_bounded_and_not_an_infinite_paid_loop(self):
        for retries in range(3):
            client = ResponsesClient(PROFILE, KEYS, request=lambda *a: (503, {}),
                                     channel_cooldown_seconds=.01, channel_recovery_retries=retries)
            with self.assertRaisesRegex(TranslationFailure, "all_translation_channels_failed"):
                client.generate("x", "i")
            self.assertEqual(client.requests, 3 * (retries + 1))

    def test_one_recovery_round_waits_for_staggered_channels_after_an_early_probe_fails(self):
        used = []
        def request(url, key, *args):
            used.append(key)
            return (503, {}) if key != KEYS[KEY_IDS[2]] else completed()
        client = ResponsesClient(PROFILE, KEYS, request=request, channel_cooldown_seconds=.01)
        for index, name in enumerate(KEY_IDS):
            client._cool(name, .02 + index * .05, recoverable=True)
        self.assertEqual(client.generate('x', 'i'), 'ok')
        self.assertEqual(used, list(KEYS.values()))
        self.assertEqual([r['recoveryRound'] for r in client.receipts], [1, 1, 1])
        self.assertEqual(client.snapshot()['channelFailures'], 2)
        self.assertTrue(all(r['batchId'] == 1 for r in client.snapshot()['recoveryWaits']))

    def test_recovery_never_repeats_an_attempted_channel_within_the_same_round(self):
        used = []
        def request(url, key, *args):
            used.append(key)
            return 503, {}
        client = ResponsesClient(PROFILE, KEYS, request=request, channel_cooldown_seconds=.01)
        for index, name in enumerate(KEY_IDS):
            client._cool(name, .02 + index * .05, recoverable=True)
        with self.assertRaisesRegex(TranslationFailure, 'all_translation_channels_failed'):
            client.generate('x', 'i')
        self.assertEqual(used, list(KEYS.values()))
        self.assertEqual([r['recoveryRound'] for r in client.receipts], [1, 1, 1])

    def test_inherited_legacy_cooldown_waits_and_only_one_recovery_probe_is_inflight(self):
        entered, release = threading.Event(), threading.Event()
        used = []
        def request(url, key, *args):
            used.append(key)
            if len(used) == 1:
                entered.set()
                if not release.wait(2):
                    raise AssertionError("probe barrier timeout")
            return completed()
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "cooldowns.json"
            client = ResponsesClient(PROFILE, {KEY_IDS[0]: KEYS[KEY_IDS[0]]}, request=request,
                                     cooldown_file=file, max_concurrency=4)
            file.write_text(json.dumps({client._cool_key(KEY_IDS[0]): time.time() + .04}))
            client = ResponsesClient(PROFILE, {KEY_IDS[0]: KEYS[KEY_IDS[0]]}, request=request,
                                     cooldown_file=file, max_concurrency=4)
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(client.generate, "x", "i") for _ in range(4)]
                try:
                    self.assertTrue(entered.wait(1))
                    time.sleep(.08)
                    self.assertEqual(len(used), 1)
                finally:
                    release.set()
                self.assertEqual([future.result(2) for future in futures], ["ok"] * 4)
            self.assertEqual(client.requests, 4)
            self.assertEqual(sum(r.get("recoveryProbe", False) for r in client.receipts), 1)
            self.assertEqual(json.loads(file.read_text()), {})

    def test_authentication_cooldown_is_not_waited_or_probed(self):
        started = time.monotonic()
        client = ResponsesClient(PROFILE, KEYS, request=lambda *a: (401, {}))
        with self.assertRaisesRegex(TranslationFailure, "all_translation_credentials_unavailable"):
            client.generate("x", "i")
        self.assertEqual(client.requests, 3)
        self.assertLess(time.monotonic() - started, .5)
        self.assertEqual(client.snapshot()["recoveryWaits"], [])

    def test_cooldown_wait_respects_cancellation_budget_and_total_deadline(self):
        client = ResponsesClient(PROFILE, KEYS, request=lambda *a: (503, {}), max_requests=3)
        with self.assertRaisesRegex(TranslationFailure, "translation_budget_exhausted"):
            client.generate("x", "i")
        self.assertEqual(client.requests, 3)
        client = ResponsesClient(PROFILE, KEYS, request=lambda *a: (503, {}), channel_cooldown_seconds=.2,
                                 execution_timeout_seconds=.05)
        started = time.monotonic()
        with self.assertRaises(TranslationFailure):
            client.generate("x", "i")
        self.assertLess(time.monotonic() - started, .2)
        client = ResponsesClient(PROFILE, KEYS, request=lambda *a: (503, {}))
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(client.generate, "x", "i")
            until = time.monotonic() + 1
            while not client.snapshot()["recoveryWaits"] and time.monotonic() < until:
                time.sleep(.01)
            client.fail("test_cancel", annotate=False)
            with self.assertRaisesRegex(TranslationFailure, "test_cancel"):
                future.result(.5)
        self.assertEqual(client.requests, 3)

    def test_http2_stream_error_is_a_retryable_channel_error(self):
        used = []
        def request(url, key, *args):
            used.append(key)
            if len(used) == 1:
                raise TranslationFailure("api_stream_error", {"apiErrorCode": "upstream_http2_stream_error"})
            return completed()
        client = ResponsesClient(PROFILE, KEYS, request=request)
        self.assertEqual(client.generate("x", "i"), "ok")
        self.assertEqual(used, list(KEYS.values())[:2])

    def test_real_blocking_headers_and_stream_are_cancelled_promptly(self):
        for path in ("/headers", "/stream"):
            with self.subTest(path=path), local_server() as (url, ready, release):
                cancel = threading.Event()
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(http_request, url + path, "synthetic-private", {"stream": True}, 5,
                                         cancel_event=cancel)
                    self.assertTrue(ready.wait(2))
                    started = time.monotonic()
                    cancel.set()
                    with self.assertRaisesRegex(TranslationFailure, "api_request_cancelled_unknown"):
                        future.result(1)
                    self.assertLess(time.monotonic() - started, .7)

    def test_native_client_terminal_failure_interrupts_another_paid_wait_and_keeps_unknown_usage(self):
        with local_server() as (url, ready, release):
            client = ResponsesClient(PROFILE, KEYS, max_concurrency=2, timeout=5)
            # Local transport fixture only. Production endpoint validation remains unchanged.
            client.profile["baseUrl"] = url
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                waiting = pool.submit(client.generate, "waiting", "i")
                self.assertTrue(ready.wait(2))
                started = time.monotonic()
                bad = pool.submit(client.generate, "bad", "i")
                for future in (bad, waiting):
                    with self.assertRaisesRegex(TranslationFailure, "responses_http_400"):
                        future.result(1.5)
                self.assertLess(time.monotonic() - started, 1)
            usage = client.snapshot()
            self.assertEqual((usage["requests"], usage["inFlight"], usage["unknownUsageAttempts"]), (2, 0, 2))
            cancelled = [r for r in usage["receipts"] if r.get("outcome") == "cancelled"]
            self.assertEqual(len(cancelled), 1)
            self.assertEqual(cancelled[0]["error"], "api_request_cancelled_unknown")
            self.assertLess(cancelled[0]["cancellationDelaySeconds"], .7)
            self.assertEqual(usage["channelFailures"], 0)
            self.assertNotIn("PRIVATE", json.dumps(usage))

    def test_transport_diagnostics_are_safe_and_distinguish_connect_headers_from_stream(self):
        cause = ConnectionResetError(104, "PRIVATE-EXCEPTION-MESSAGE")
        details = transport_error_details(urllib.error.URLError(cause), "read_stream")
        self.assertEqual(details, {"transportExceptionType": "URLError", "transportPhase": "read_stream",
                                  "transportCauseType": "ConnectionResetError", "transportErrno": 104})
        self.assertNotIn("PRIVATE", json.dumps(details))
        with local_server() as (url, ready, release):
            with self.assertRaises(TranslationFailure) as caught:
                blocking_http_request(url + "/headers", "synthetic", {"stream": True}, .1)
            self.assertEqual(caught.exception.details["transportPhase"], "connect_or_headers")
            self.assertEqual(caught.exception.details["transportCauseType"], "TimeoutError")

    def test_supervised_http_success_and_terminal_progress_keep_usage_and_timings(self):
        with local_server() as (url, ready, release):
            progress = []
            status, response = http_request(url + "/ok", "synthetic", {"stream": True}, 2,
                                           on_progress=progress.append)
            self.assertEqual(status, 200)
            self.assertEqual(response["usage"], {"input_tokens": 3, "output_tokens": 5})
            self.assertEqual(progress[-1]["lastEvent"], "response.completed")
            self.assertIn("lastEventOffsetSeconds", progress[-1])
            self.assertIsNone(progress[-1]["lastOutputOffsetSeconds"])

    def test_bad_retry_limits_are_rejected_before_network_work(self):
        for value in (-1, 5, True, "1", 1.5):
            for name in ("batch_validation_retries", "channel_recovery_retries"):
                with self.assertRaisesRegex(TranslationFailure, "invalid_translation_retry_limit"):
                    ResponsesClient(PROFILE, KEYS, **{name: value})


if __name__ == "__main__":
    unittest.main()
