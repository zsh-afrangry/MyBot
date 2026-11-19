"""Offline pinned-engine cache trace: one synthetic API reply and later cache reuse."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[2]
CACHE=tempfile.TemporaryDirectory(prefix='paper-cache-trace-')
os.environ['HOME']=CACHE.name
os.environ['XDG_CACHE_HOME']=CACHE.name+'/.cache'
sys.path.insert(0,str(ROOT/'plugins/kurumi-papers/python'))
sys.path.insert(0,str(ROOT/'packages/observability'))
from responses import ResponsesClient,KEY_IDS
from engine import create_translator
from trace_store import TraceStore

class CacheTraceTest(unittest.TestCase):
    def test_repeated_text_uses_cache_and_links_the_recorded_origin(self):
        profile={'provider':'openai','channel':'naiccc','protocol':'responses','model':'gpt-6.1-sol','effort':'high','baseUrl':'https://naiccc.com/v1'}
        seen=[]
        def respond(*args):
            seen.append(args)
            return 200,{'model':profile['model'],'status':'completed','usage':{'input_tokens':8,'output_tokens':9},
                        'output':[{'type':'message','role':'assistant','content':[{'type':'output_text','text':'合成译文'}]}]}
        with tempfile.TemporaryDirectory() as directory:
            def translator(execution):
                trace=TraceStore(directory,execution,'engine',correlation={'subjectId':'fixture'})
                client=ResponsesClient(profile,{KEY_IDS[0]:'synthetic-key'},request=respond,trace=trace)
                return create_translator({'sourceLang':'en','targetLang':'zh','profile':profile},client),client
            text='Synthetic input '+uuid.uuid4().hex
            first,client=translator('first')
            self.assertEqual(first.translate(text),'合成译文')
            second,reuse=translator('second')
            self.assertEqual(second.translate(text),'合成译文')
            self.assertEqual(len(seen),1)
            self.assertEqual(reuse.snapshot()['requests'],0)
            with sqlite3.connect(Path(directory)/'executions.sqlite') as db:
                rows=[json.loads(row[0]) for row in db.execute('SELECT record_json FROM trace_events')]
            hits=[row for row in rows if row['data']['type']=='cache' and row['data']['status']=='hit']
            self.assertEqual(hits[0]['data']['links'],[{'executionId':'first','spanId':'request:1'}])

if __name__=='__main__':
    unittest.main()
