"""Offline concurrency regression: injected HTTP, synthetic data, temporary files only.

Development owner: docs/22_论文PDF翻译与文件投递.md.
"""
import concurrent.futures
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "plugins/kurumi-papers/python"))
from responses import ResponsesClient, TranslationFailure, atomic_json, KEY_IDS

PROFILE = {"provider": "openai", "channel": "naiccc", "model": "gpt-6.1-sol",
           "effort": "max", "protocol": "responses", "baseUrl": "https://naiccc.com/v1"}
KEYS = dict(zip(KEY_IDS, ("synthetic-014", "synthetic-030", "synthetic-040")))


def reply(label, tokens=17):
    return 200, {"id": "resp-" + label, "status": "completed", "model": PROFILE["model"],
                 "usage": {"input_tokens": 1, "output_tokens": tokens - 1},
                 "output": [{"type": "message", "role": "assistant",
                             "content": [{"type": "output_text", "text": label}]}]}


class ConcurrencyTest(unittest.TestCase):
    def test_six_calls_overlap_and_queued_callers_cannot_take_a_seventh_slot(self):
        lock, reached, release = threading.Lock(), threading.Event(), threading.Event()
        active = peak = calls = 0
        def request(url, key, body, timeout):
            nonlocal active, peak, calls
            with lock:
                calls += 1; active += 1; peak = max(peak, active)
                if active == 6: reached.set()
            if not release.wait(3): raise AssertionError("network barrier timed out")
            with lock: active -= 1
            return reply(body["input"])
        client = ResponsesClient(PROFILE, KEYS, request=request, max_concurrency=6)
        with concurrent.futures.ThreadPoolExecutor(max_workers=11) as pool:
            futures = [pool.submit(client.generate, str(i), "i") for i in range(11)]
            try:
                self.assertTrue(reached.wait(2))
                self.assertEqual(calls, 6)
                self.assertEqual(client.snapshot()["inFlight"], 6)
            finally: release.set()
            self.assertEqual([f.result(3) for f in futures], list(map(str, range(11))))
        self.assertEqual(peak, 6)
        usage = client.snapshot()
        self.assertEqual((usage["requests"], usage["reportedTokens"], usage["inFlight"]), (11, 187, 0))
        self.assertEqual(usage["peakInFlight"], 6)

    def test_four_calls_really_overlap_and_all_additional_callers_wait(self):
        lock, four, release = threading.Lock(), threading.Event(), threading.Event()
        active = peak = calls = 0
        def request(url, key, body, timeout):
            nonlocal active, peak, calls
            with lock:
                calls += 1; active += 1; peak = max(peak, active)
                if active == 4: four.set()
            if not release.wait(3): raise AssertionError("network barrier timed out")
            with lock: active -= 1
            return reply(body["input"])
        client = ResponsesClient(PROFILE, KEYS, request=request, max_concurrency=4)
        with concurrent.futures.ThreadPoolExecutor(max_workers=9) as pool:
            futures = [pool.submit(client.generate, str(i), "i") for i in range(9)]
            try:
                self.assertTrue(four.wait(2))
                self.assertEqual(calls, 4)
                self.assertEqual(client.snapshot()["inFlight"], 4)
            finally: release.set()
            self.assertEqual([f.result(3) for f in futures], list(map(str, range(9))))
        self.assertEqual(peak, 4)
        usage = client.snapshot()
        self.assertEqual((usage["requests"], usage["reportedTokens"], usage["inFlight"]), (9, 153, 0))
        self.assertEqual(usage["peakInFlight"], 4)

    def test_out_of_order_results_keep_their_own_receipts_and_immutable_snapshots(self):
        barrier = threading.Barrier(4)
        release = [threading.Event() for _ in range(4)]
        def request(url, key, body, timeout):
            n = int(body["input"]); barrier.wait(3)
            if not release[n].wait(3): raise AssertionError("reply gate timed out")
            return reply(str(n), 10 + n)
        snapshots = []
        client = ResponsesClient(PROFILE, KEYS, request=request, max_concurrency=4,
                                 on_usage=lambda value: snapshots.append(value))
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(client.generate, str(i), "i") for i in range(4)]
            try:
                for n in (3, 1, 2, 0):
                    release[n].set()
                    self.assertEqual(futures[n].result(3), str(n))
            finally:
                for event in release: event.set()
        receipts = client.snapshot()["receipts"]
        self.assertEqual({r["responseId"]: r["usage"]["output_tokens"] for r in receipts},
                         {"resp-" + str(i): 9 + i for i in range(4)})
        self.assertEqual(client.snapshot()["reportedTokens"], 46)
        self.assertTrue(any("usage" not in r for r in snapshots[0]["receipts"]))
        copy = client.snapshot(); copy["receipts"][0]["usage"]["output_tokens"] = 999
        self.assertNotEqual(client.snapshot()["receipts"][0]["usage"]["output_tokens"], 999)
        self.assertEqual([s["reportedTokens"] for s in snapshots], sorted(s["reportedTokens"] for s in snapshots))

    def test_request_budget_is_strict_and_inflight_results_remain_accounted(self):
        reached, release = threading.Event(), threading.Event()
        def request(url, key, body, timeout):
            if client.requests == 3: reached.set()
            if not release.wait(3): raise AssertionError("budget barrier timed out")
            return reply(body["input"])
        client = ResponsesClient(PROFILE, KEYS, request=request, max_concurrency=4, max_requests=3)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(client.generate, str(i), "i") for i in range(8)]
            try:
                self.assertTrue(reached.wait(2))
                self.assertTrue(client.stopped.wait(2))
            finally: release.set()
            values, errors = [], []
            for future in futures:
                try: values.append(future.result(3))
                except TranslationFailure as error: errors.append(str(error))
        self.assertEqual(len(values), 3); self.assertEqual(len(errors), 5)
        self.assertEqual(client.requests, 3); self.assertEqual(client.snapshot()["reportedTokens"], 51)
        self.assertEqual(set(errors), {"translation_budget_exhausted"})
        self.assertTrue(all("error" not in r for r in client.snapshot()["receipts"]))

    def test_known_token_limit_stops_new_requests_but_retains_all_inflight_usage(self):
        barrier = threading.Barrier(4)
        release = [threading.Event() for _ in range(4)]
        def request(url, key, body, timeout):
            n = int(body["input"]); barrier.wait(3)
            if not release[n].wait(3): raise AssertionError("token barrier timed out")
            return reply(str(n), 20)
        client = ResponsesClient(PROFILE, KEYS, request=request, max_concurrency=4, max_tokens=20)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(client.generate, str(i), "i") for i in range(4)]
            try:
                release[0].set(); self.assertEqual(futures[0].result(3), "0")
                with self.assertRaisesRegex(TranslationFailure, "translation_budget_exhausted"):
                    client.generate("extra", "i")
            finally:
                for event in release: event.set()
            for future in futures: future.result(3)
        usage = client.snapshot()
        self.assertEqual((usage["requests"], usage["reportedTokens"]), (4, 80))
        self.assertFalse(usage["hardCostLimit"])
        self.assertTrue(all("error" not in r for r in usage["receipts"]))

    def test_terminal_error_cancels_waiters_without_tainting_other_receipts(self):
        four, release, fail = threading.Event(), threading.Event(), threading.Event()
        count, lock = 0, threading.Lock()
        def request(url, key, body, timeout):
            nonlocal count
            with lock:
                count += 1
                if count == 4: four.set()
            if body["input"] == "bad":
                if not fail.wait(3): raise AssertionError("failure gate timed out")
                return 400, {}
            if not release.wait(3): raise AssertionError("success gate timed out")
            return reply(body["input"])
        client = ResponsesClient(PROFILE, KEYS, request=request, max_concurrency=4)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            futures = [pool.submit(client.generate, text, "i") for text in ("bad", "a", "b", "c")]
            try:
                self.assertTrue(four.wait(2))
                queued = [pool.submit(client.generate, "queued", "i") for _ in range(2)]
                fail.set()
                with self.assertRaisesRegex(TranslationFailure, "responses_http_400"): futures[0].result(2)
                for future in queued:
                    with self.assertRaisesRegex(TranslationFailure, "responses_http_400"): future.result(2)
            finally: fail.set(); release.set()
            for future in futures[1:]: future.result(3)
        usage = client.snapshot()
        self.assertEqual((count, usage["reportedTokens"], usage["inFlight"]), (4, 51, 0))
        self.assertEqual(len([r for r in usage["receipts"] if r.get("error")]), 1)
        self.assertEqual(usage["failure"], "responses_http_400")

    def test_rate_spacing_includes_retry_and_failover(self):
        times, used = [], []
        def request(url, key, body, timeout):
            times.append(time.monotonic()); used.append(key)
            return (429, {"error": {"code": "rate_limit_exceeded"}}) if key.endswith("014") else reply("ok")
        client = ResponsesClient(PROFILE, KEYS, request=request, max_concurrency=4,
                                 max_qps=20, sleep=lambda _: None)
        self.assertEqual(client.generate("x", "i"), "ok")
        self.assertEqual(used, [KEYS[KEY_IDS[0]], KEYS[KEY_IDS[0]], KEYS[KEY_IDS[1]]])
        self.assertTrue(all(b - a >= .045 for a, b in zip(times, times[1:])), times)

    def test_pacing_waiters_stop_without_waiting_for_the_next_rate_slot(self):
        called = threading.Event()
        def request(*args): called.set(); return reply("ok")
        client = ResponsesClient(PROFILE, KEYS, request=request, max_concurrency=4, max_qps=.1)
        client.generate("first", "i")
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(client.generate, "waiter", "i")
            client.fail("test_terminal", annotate=False)
            with self.assertRaisesRegex(TranslationFailure, "test_terminal"): future.result(.5)
        self.assertEqual(client.requests, 1)
        self.assertNotIn("error", client.receipts[0])

    def test_concurrent_channel_failure_shares_cooldown_and_preserves_unknown_usage(self):
        barrier, used, lock = threading.Barrier(4), [], threading.Lock()
        def request(url, key, body, timeout):
            with lock: used.append(key)
            if key.endswith("014"):
                barrier.wait(3)
                raise TranslationFailure("api_stream_interrupted_unknown")
            return reply(body["input"])
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "cooldowns.json"
            client = ResponsesClient(PROFILE, KEYS, request=request, max_concurrency=4, cooldown_file=file)
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(client.generate, str(i), "i") for i in range(4)]
                for future in futures: future.result(3)
            self.assertEqual(used.count(KEYS[KEY_IDS[0]]), 4)
            self.assertEqual(used.count(KEYS[KEY_IDS[1]]), 4)
            usage = client.snapshot()
            self.assertEqual((usage["requests"], usage["unknownUsageAttempts"], usage["reportedTokens"]), (8, 4, 68))
            self.assertNotIn("synthetic", file.read_text())
            used.clear()
            ResponsesClient(PROFILE, KEYS, request=request, cooldown_file=file).generate("next", "i")
            self.assertEqual(used, [KEYS[KEY_IDS[1]]])

    def test_atomic_writer_handles_simultaneous_replacements_without_temp_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "same.json"
            def writer(n):
                for i in range(30):
                    atomic_json(file, {"writer": n, "payload": [n] * 100})
                    value = json.loads(file.read_text())
                    self.assertEqual(value["payload"], [value["writer"]] * 100)
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(writer, range(8)))
            self.assertEqual(list(Path(directory).glob("*.tmp-*")), [])

    def test_bad_concurrency_fails_before_any_request(self):
        for concurrency in (0, 7, True, "6", 1.5):
            with self.assertRaisesRegex(TranslationFailure, "invalid_translation_concurrency"):
                ResponsesClient(PROFILE, KEYS, max_concurrency=concurrency)
        for qps in (0, -1, True, "4", float("nan")):
            with self.assertRaisesRegex(TranslationFailure, "invalid_translation_concurrency"):
                ResponsesClient(PROFILE, KEYS, max_qps=qps)


if __name__ == "__main__": unittest.main()
