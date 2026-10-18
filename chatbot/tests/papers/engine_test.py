# Offline installed-engine contract test. No model/network/delivery; isolated HOME/cache.
# Run with the pinned paper Python runtime. Development owner: docs/22.
import os
from pathlib import Path
import re
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
import threading
import asyncio
import concurrent.futures
import contextlib
from types import SimpleNamespace

cache = tempfile.TemporaryDirectory(prefix="kurumi-engine-test-")
os.environ["HOME"] = cache.name
os.environ["XDG_CACHE_HOME"] = cache.name + "/.cache"
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "plugins/kurumi-papers/python"))
from engine import create_translator, translate_batch, create_monitor, translate, execution_limits
from responses import TranslationFailure, ResponsesClient, KEY_IDS, PROFILE_REGISTRY


class Client:
    def __init__(self): self.calls = []
    @contextlib.contextmanager
    def batch_context(self):
        yield {"attempt":0}
    def record_validation_failure(self, validation, **kwargs):
        self.last_validation = validation
    def fail(self, code, *, validation=None):
        self.failure, self.validation_failure = code, validation
    def normalize_json_fence(self):
        self.normalized_json_fences = getattr(self, 'normalized_json_fences', 0) + 1
    def generate(self, text, instructions, **kwargs):
        self.calls.append((text, instructions, kwargs))
        return "翻译结果"


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.translator = create_translator({"sourceLang":"en", "targetLang":"zh",
            "profile":{"provider":"openai", "channel":"naiccc", "protocol":"responses",
                       "model":"gpt-6.1-sol", "effort":"max"}}, self.client)

    def test_operator_settings_reach_both_limiters_and_the_pinned_pool(self):
        with tempfile.TemporaryDirectory() as directory:
            request={"input":directory+"/input.pdf","output":directory,"sourceLang":"en","targetLang":"zh",
                     "profile":{},"keys":{},"maxRequests":200,"maxReportedTokens":150000,
                     "apiConcurrency":6,"apiQps":1,"requestIdleTimeoutSeconds":77}
            with patch('engine.ResponsesClient') as client, patch('engine.create_translator'), \
                 patch('engine.create_monitor'), \
                 patch('babeldoc.translator.translator.set_translate_rate_limiter') as limiter, \
                 patch('babeldoc.format.pdf.translation_config.TranslationConfig') as config, \
                 patch('babeldoc.format.pdf.high_level.get_translation_stage',return_value=[]), \
                 patch('babeldoc.format.pdf.high_level.do_translate',
                       return_value=SimpleNamespace(mono_pdf_path='mono.pdf',dual_pdf_path='dual.pdf')):
                client.return_value.failure=None;client.return_value.snapshot.return_value={"requests":0}
                translate(request)
                self.assertEqual(client.call_args.kwargs['max_concurrency'],6)
                self.assertEqual(client.call_args.kwargs['max_qps'],1)
                self.assertEqual(client.call_args.kwargs['idle_timeout_seconds'],77)
                limiter.assert_called_once_with(1)
                self.assertEqual(config.call_args.kwargs['pool_max_workers'],6)
                self.assertEqual(config.call_args.kwargs['term_pool_max_workers'],1)
                self.assertEqual(config.call_args.kwargs['qps'],1)
                self.assertTrue(Path(directory,'result.json').exists())
        self.assertEqual(execution_limits({}),(1,1))
        for concurrency in (4,5,6):
            self.assertEqual(execution_limits({'apiConcurrency':concurrency}),(concurrency,1))
        for args in ({'apiConcurrency':7},{'apiQps':5},{'apiQps':0},{'apiConcurrency':True},{'apiQps':1.5}):
            with self.assertRaisesRegex(TranslationFailure,'invalid_translation_concurrency'):
                execution_limits(args)

    def test_output_selection_reaches_pinned_config_and_never_publishes_unselected_paths(self):
        for output in ('dual', 'mono', 'both', None):
            with self.subTest(output=output), tempfile.TemporaryDirectory() as directory:
                request={'input':directory+'/input.pdf','output':directory,'sourceLang':'en','targetLang':'zh',
                         'profile':{},'keys':{},'maxRequests':200,'maxReportedTokens':300000}
                if output is not None: request['outputKind']=output
                kinds=('dual','mono') if output=='both' else (output or 'dual',)
                finished=SimpleNamespace(**{kind+'_pdf_path':kind+'.pdf' for kind in kinds})
                with patch('engine.ResponsesClient') as client, patch('engine.create_translator'), \
                     patch('engine.create_monitor'), \
                     patch('babeldoc.format.pdf.translation_config.TranslationConfig') as config, \
                     patch('babeldoc.format.pdf.high_level.get_translation_stage',return_value=[]), \
                     patch('babeldoc.format.pdf.high_level.do_translate',return_value=finished):
                    client.return_value.failure=None;client.return_value.snapshot.return_value={'requests':0}
                    translate(request)
                self.assertEqual(client.call_args.kwargs['idle_timeout_seconds'],100)
                self.assertEqual(config.call_args.kwargs['no_mono'],'mono' not in kinds)
                self.assertEqual(config.call_args.kwargs['no_dual'],'dual' not in kinds)
                result=json.loads(Path(directory,'result.json').read_text())
                self.assertEqual({key for key in result if key in ('dual','mono')},set(kinds))

    def test_missing_selected_output_fails_and_invalid_selection_starts_no_api_client(self):
        with tempfile.TemporaryDirectory() as directory:
            request={'input':directory+'/input.pdf','output':directory,'sourceLang':'en','targetLang':'zh',
                     'profile':{},'keys':{},'maxRequests':200,'maxReportedTokens':300000,'outputKind':'dual'}
            with patch('engine.ResponsesClient') as client, patch('engine.create_translator'), \
                 patch('engine.create_monitor'), \
                 patch('babeldoc.format.pdf.translation_config.TranslationConfig'), \
                 patch('babeldoc.format.pdf.high_level.get_translation_stage',return_value=[]), \
                 patch('babeldoc.format.pdf.high_level.do_translate',
                       return_value=SimpleNamespace(mono_pdf_path='mono.pdf',dual_pdf_path=None)):
                client.return_value.failure=None
                with self.assertRaisesRegex(TranslationFailure,'missing_selected_pdf_output'):translate(request)
                self.assertFalse(Path(directory,'result.json').exists())
            for output in ('english','',[],False):
                with patch('engine.ResponsesClient') as client:
                    with self.assertRaisesRegex(TranslationFailure,'invalid_pdf_output'):translate({**request,'outputKind':output})
                    client.assert_not_called()

    def test_shared_registry_defaults_are_high_and_explicit_max_remains_supported(self):
        for provider in PROFILE_REGISTRY['providers']:
            self.assertEqual(provider['defaultEffort'],'high')
            self.assertIn('max',provider['models'][provider['defaultModel']])

    def test_pinned_monitor_normal_finish_and_explicit_cancel_need_no_async_bridge(self):
        event=threading.Event();events=[]
        monitor=create_monitor([('Save PDF',1)],lambda **e:events.append(e),event)
        monitor.translate_done(object())
        monitor.on_finish()  # Previously raised TypeError calling a missing finish_callback.
        self.assertTrue(event.is_set());self.assertEqual(events[0]['type'],'stage_summary')
        cancel=threading.Event();monitor=create_monitor([('Translate',1)],lambda **e:None,cancel)
        cancel.set()
        with self.assertRaises(asyncio.CancelledError):monitor.raise_if_cancelled()

    def test_capability_probe_is_local_and_all_translation_paths_use_the_adapter(self):
        self.assertIsNone(self.translator.do_llm_translate(None))
        self.assertIsNone(self.translator.llm_translate(None))
        self.assertEqual(self.client.calls, [])
        self.translator.do_translate("text {v1}")
        self.translator.do_llm_translate("structured translation")
        self.assertEqual(len(self.client.calls), 2)
        self.assertTrue(self.client.calls[0][2]["preserve_placeholders"])
        self.assertIn("JSON/output structure", self.client.calls[1][1])

    def test_terminal_failure_stops_engine_before_any_more_rate_limited_or_cached_work(self):
        self.client.failure='all_translation_channels_failed'
        with patch('babeldoc.translator.translator._translate_rate_limiter.wait',side_effect=AssertionError('must not wait')):
            for method in (self.translator.translate,self.translator.llm_translate):
                with self.assertRaisesRegex(TranslationFailure,'all_translation_channels_failed'):method('some input')
        self.assertIsNone(self.translator.llm_translate(None))
        self.assertEqual(self.client.calls,[])

    def test_formula_and_style_contract_matches_the_installed_engine(self):
        for method in (self.translator.get_formular_placeholder,
                       self.translator.get_rich_text_left_placeholder,
                       self.translator.get_rich_text_right_placeholder):
            literal, pattern = method(12)
            self.assertIsNotNone(re.fullmatch(pattern, literal))
            _, generic = method(r"\d+")
            self.assertIsNotNone(re.fullmatch(generic, literal))

    def test_completed_engine_results_are_cached_without_repeating_paid_calls(self):
        self.translator.llm_translate('cache-contract-unique-text')
        self.translator.llm_translate('cache-contract-unique-text')
        self.assertEqual(len(self.client.calls),1)

    def test_batch_retry_only_caches_the_valid_result_and_an_exhausted_batch_is_not_cached(self):
        profile={"provider":"openai","channel":"naiccc","protocol":"responses",
                 "baseUrl":"https://naiccc.com/v1","model":"gpt-6.1-sol","effort":"high"}
        config={"sourceLang":"en","targetLang":"zh","profile":profile}
        for succeeds in (False, True):
            seen=[]
            def request(*args):
                seen.append(1)
                text='[{"id":1,"output":"译文 {v1}"}]' if succeeds and len(seen)>1 else '[{"id":1,"output":"lost"}]'
                return 200,{"status":"completed","model":profile['model'],"usage":{"input_tokens":3,"output_tokens":2},
                    "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}]}
            client=ResponsesClient(profile,{KEY_IDS[0]:"synthetic"},request=request)
            translator=create_translator(config,client)
            prompt='cache-retry-'+str(succeeds)+'\n## Here is the input:\n'+json.dumps([{'id':1,'input':'text {v1}'}])
            if succeeds:
                translator.llm_translate(prompt);translator.llm_translate(prompt)
                self.assertEqual(len(seen),2)
            else:
                with self.assertRaisesRegex(TranslationFailure,'invalid_batch_translation'):translator.llm_translate(prompt)
                class Fresh(Client):
                    def generate(self,*args,**kwargs):
                        self.calls.append(1)
                        return '[{"id":1,"output":"译文 {v1}"}]'
                fresh=Fresh()
                create_translator(config,fresh).llm_translate(prompt)
                self.assertEqual(len(fresh.calls),1)
                self.assertEqual(len(seen),2)

    def test_inflight_success_is_cached_even_when_another_request_stops_the_job(self):
        profile={"provider":"openai","channel":"naiccc","protocol":"responses",
                 "baseUrl":"https://naiccc.com/v1","model":"gpt-6.1-sol","effort":"max"}
        ready, release = threading.Event(), threading.Event()
        def request(url,key,body,timeout):
            ready.set()
            if not release.wait(3): raise AssertionError('cache barrier timed out')
            return 200,{"id":"cached-response","status":"completed","model":profile["model"],
                        "usage":{"input_tokens":3,"output_tokens":2},
                        "output":[{"type":"message","role":"assistant",
                                   "content":[{"type":"output_text","text":"已缓存的成功译文"}]}]}
        client=ResponsesClient(profile,{KEY_IDS[0]:"synthetic"},request=request,max_concurrency=4)
        config={"sourceLang":"en","targetLang":"zh","profile":profile}
        translator=create_translator(config,client)
        text='inflight-success-cache-contract'
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(translator.llm_translate,text)
            try:
                self.assertTrue(ready.wait(2));client.fail('other_batch_invalid',annotate=False)
            finally: release.set()
            self.assertEqual(future.result(3),'已缓存的成功译文')
        self.assertEqual(client.snapshot()['reportedTokens'],5)
        self.assertEqual(client.snapshot()['failure'],'other_batch_invalid')
        fresh=Client()
        self.assertEqual(create_translator(config,fresh).llm_translate(text),'已缓存的成功译文')
        self.assertEqual(fresh.calls,[])

    def test_provider_model_and_effort_have_separate_cache_namespaces(self):
        base={'sourceLang':'en','targetLang':'zh','profile':{'provider':'deepseek','channel':'official',
              'protocol':'responses','baseUrl':'https://api.deepseek.com','model':'deepseek-flash','effort':'none'}}
        text='provider-model-effort-cache-isolation-unique'
        for profile in (self.translator,create_translator(base,self.client),
                create_translator({**base,'profile':{**base['profile'],'model':'deepseek-v4-pro'}},self.client),
                create_translator({**base,'profile':{**base['profile'],'effort':'max'}},self.client)):
            profile.llm_translate(text)
            profile.llm_translate(text)
        self.assertEqual(len(self.client.calls),4)

    def test_real_engine_batch_template_becomes_data_and_retains_ids_and_formulas(self):
        from babeldoc.format.pdf.document_il.midend.il_translator_llm_only import PROMPT_TEMPLATE
        source=[{"id":7,"input":"Hello {v1}","layout_label":"text"}]
        prompt=PROMPT_TEMPLATE.substitute(role_block='role',lang_out='zh',glossary_usage_rules_block='',
            contextual_hints_block='',glossary_tables_block='',json_input_str=json.dumps(source))
        seen=[]
        class BatchClient(Client):
            def generate(self,text,instructions):
                seen.append((json.loads(text),instructions))
                return json.dumps([{"id":7,"output":"你好 {v1}"}])
        result=json.loads(translate_batch(BatchClient(),prompt,'en','zh'))
        self.assertEqual(result,[{"id":7,"output":"你好 {v1}"}])
        self.assertEqual(seen[0][0],[{"id":7,"input":"Hello {v1}"}])
        self.assertIn('JSON array',seen[0][1])
        class BrokenClient(Client):
            def generate(self,*args):return '[{"id":7,"output":"formula lost"}]'
        with self.assertRaisesRegex(TranslationFailure,'invalid_batch_translation'):
            translate_batch(BrokenClient(),prompt,'en','zh')

    def test_batch_accepts_a_single_json_fence_and_keeps_strict_structure_and_formula_checks(self):
        prompt='## Here is the input:\n'+json.dumps([{'id':1,'input':'Private synthetic text {v1}'}])
        class BatchClient(Client):
            def __init__(self,output):self.output=output
            def generate(self,*args):return self.output
        valid='[{"id":1,"output":"译文 {v1}"}]'
        client=BatchClient('```json\n'+valid+'\n```')
        self.assertEqual(json.loads(translate_batch(client,prompt,'en','zh')),[{'id':1,'output':'译文 {v1}'}])
        self.assertEqual(client.normalized_json_fences,1)
        for raw in ('Explanation\n'+valid,'```json\n'+valid+'\n```\nCommentary','```python\n'+valid+'\n```',
                    '```json\n[{"id":1,"output":"lost placeholder"}]\n```'):
            client=BatchClient(raw)
            with self.assertRaisesRegex(TranslationFailure,'invalid_batch_translation'):translate_batch(client,prompt,'en','zh')
            self.assertIn(client.validation_failure['reason'],('invalid_json','placeholder_mismatch'))
            self.assertNotIn('Private synthetic text',json.dumps(client.validation_failure))

    def test_structured_batch_uses_native_schema_and_still_rejects_wrong_ids_and_placeholders(self):
        prompt='## Here is the input:\n'+json.dumps([{'id':3,'input':"<style id='1'>Study</style> {v1}"}])
        class StructuredClient(Client):
            batch_format='json_schema'
            def __init__(self,output):self.output=output;self.seen=None
            def generate(self,text,instructions,**options):self.seen=(text,instructions,options);return json.dumps(self.output)
        result={'translations':[{'id':3,'output':"<style id='1'>研究</style> {v1}"}]}
        client=StructuredClient(result)
        self.assertEqual(json.loads(translate_batch(client,prompt,'en','zh')),result['translations'])
        format=client.seen[2]['output_format'];self.assertEqual(format['type'],'json_schema');self.assertTrue(format['strict'])
        self.assertEqual(format['schema']['properties']['translations']['items']['properties']['id']['enum'],[3])
        self.assertIn('Do not add, duplicate or remove',client.seen[1])
        for output in (result['translations'],{'translations':[]},{'translations':[{'id':4,'output':'wrong id'}]},
                       {'translations':[{'id':3,'output':'lost placeholders'}]}, {**result,'extra':'field'}):
            with self.assertRaisesRegex(TranslationFailure,'invalid_batch_translation'):
                translate_batch(StructuredClient(output),prompt,'en','zh')


if __name__ == "__main__":
    try: unittest.main()
    finally: cache.cleanup()
