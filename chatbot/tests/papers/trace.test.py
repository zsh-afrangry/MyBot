"""Offline request evidence and JS/Python storage compatibility. Synthetic data only."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import zlib

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'plugins/kurumi-papers/python'))
sys.path.insert(0,str(ROOT/'packages/observability'))
from responses import ResponsesClient, TranslationFailure, KEY_IDS
from trace_store import TraceStore

PROFILE={'provider':'openai','channel':'naiccc','protocol':'responses','model':'gpt-6.1-sol','effort':'high','baseUrl':'https://naiccc.com/v1'}
SECRET='synthetic-private-value'


class TraceTest(unittest.TestCase):
    def test_actual_parameters_body_usage_and_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            trace=TraceStore(directory,'exec-fixture','engine',secrets=[SECRET])
            def respond(url,key,body,timeout):
                self.assertEqual(body['input'],'synthetic paper text')
                return 200,{'id':'resp-fixture','model':PROFILE['model'],'status':'completed',
                    'usage':{'input_tokens':9,'output_tokens':11,'output_tokens_details':{'reasoning_tokens':5}},
                    'output':[{'type':'message','role':'assistant','content':[{'type':'output_text','text':'合成译文'}]}],
                    'unknown':SECRET}
            client=ResponsesClient(PROFILE,{KEY_IDS[0]:SECRET},request=respond,trace=trace)
            self.assertEqual(client.generate('synthetic paper text','translate only'),'合成译文')
            with sqlite3.connect(Path(directory)/'executions.sqlite') as db:
                rows=[json.loads(r[0]) for r in db.execute('SELECT record_json FROM trace_events')]
                bodies=[json.loads(zlib.decompress(r[0])) for r in db.execute('SELECT content FROM trace_details')]
            self.assertTrue(any(r['data'].get('usage',{}).get('inputTokens')==9 for r in rows))
            self.assertTrue(any(r.get('body',{}).get('input')=='synthetic paper text' for r in bodies))
            self.assertTrue(any(r.get('body',{}).get('unknown')=='[REDACTED]' for r in bodies))
            self.assertTrue(any(r.get('body',{}).get('usage',{}).get('output_tokens_details',{}).get('reasoning_tokens')==5 for r in bodies))
            self.assertNotIn(SECRET,json.dumps(rows)+json.dumps(bodies))
            self.assertEqual(client.snapshot()['reportedTokens'],20)

    def test_failed_request_keeps_parameters_and_unknown_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            trace=TraceStore(directory,'exec-failure','engine')
            def fail(*args):
                raise TranslationFailure('api_request_cancelled_unknown')
            client=ResponsesClient(PROFILE,{KEY_IDS[0]:SECRET},request=fail,trace=trace,channel_recovery_retries=0)
            with self.assertRaises(TranslationFailure):
                client.generate('synthetic input','translate')
            with sqlite3.connect(Path(directory)/'executions.sqlite') as db:
                rows=[json.loads(r[0]) for r in db.execute('SELECT record_json FROM trace_events')]
            api=[r for r in rows if r['data']['type']=='api'][-1]
            self.assertFalse(api['data']['usageKnown'])
            self.assertEqual(api['data']['details']['request']['status'],'stored')
            self.assertEqual(api['data']['status'],'cancelled')

    def test_storage_failure_cannot_fail_translation(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'file';file.write_text('not a directory')
            trace=TraceStore(file,'exec','engine')
            self.assertEqual(trace.detail({'field':'value'})['status'],'capture_failed')
            self.assertEqual(trace.node('a','stage','fixture','completed')['status'],'capture_failed')
            self.assertTrue(trace.failed)

    def test_provenance_and_truncation_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            trace=TraceStore(directory,'exec','engine',body_bytes=64)
            self.assertEqual(trace.cache_origin('key')['status'],'origin_unknown')
            trace.cache_origin('key','request:1')
            self.assertEqual(trace.cache_origin('key'),{'executionId':'exec','spanId':'request:1'})
            self.assertEqual(trace.detail({'body':'x'*100})['status'],'too_large')


if __name__=='__main__':
    unittest.main()
