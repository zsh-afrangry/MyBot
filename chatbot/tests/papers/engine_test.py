# Offline installed-engine contract test. No model/network/delivery; isolated HOME/cache.
# Run with the pinned paper Python runtime. Development owner: docs/22.
import os
from pathlib import Path
import re
import json
import sys
import tempfile
import unittest

cache = tempfile.TemporaryDirectory(prefix="kurumi-engine-test-")
os.environ["HOME"] = cache.name
os.environ["XDG_CACHE_HOME"] = cache.name + "/.cache"
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "plugins/kurumi-papers/python"))
from engine import create_translator, translate_batch
from responses import TranslationFailure


class Client:
    def __init__(self): self.calls = []
    def generate(self, text, instructions, **kwargs):
        self.calls.append((text, instructions, kwargs))
        return "翻译结果"


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.translator = create_translator({"sourceLang":"en", "targetLang":"zh",
            "profile":{"provider":"openai", "channel":"naiccc", "protocol":"responses",
                       "model":"gpt-6.1-sol", "effort":"max"}}, self.client)

    def test_capability_probe_is_local_and_all_translation_paths_use_the_adapter(self):
        self.assertIsNone(self.translator.do_llm_translate(None))
        self.assertIsNone(self.translator.llm_translate(None))
        self.assertEqual(self.client.calls, [])
        self.translator.do_translate("text {v1}")
        self.translator.do_llm_translate("structured translation")
        self.assertEqual(len(self.client.calls), 2)
        self.assertTrue(self.client.calls[0][2]["preserve_placeholders"])
        self.assertIn("JSON/output structure", self.client.calls[1][1])

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

    def test_real_engine_batch_template_becomes_data_and_retains_ids_and_formulas(self):
        from babeldoc.format.pdf.document_il.midend.il_translator_llm_only import PROMPT_TEMPLATE
        source=[{"id":7,"input":"Hello {v1}","layout_label":"text"}]
        prompt=PROMPT_TEMPLATE.substitute(role_block='role',lang_out='zh',glossary_usage_rules_block='',
            contextual_hints_block='',glossary_tables_block='',json_input_str=json.dumps(source))
        seen=[]
        class BatchClient:
            def generate(self,text,instructions):
                seen.append((json.loads(text),instructions))
                return json.dumps([{"id":7,"output":"你好 {v1}"}])
        result=json.loads(translate_batch(BatchClient(),prompt,'en','zh'))
        self.assertEqual(result,[{"id":7,"output":"你好 {v1}"}])
        self.assertEqual(seen[0][0],[{"id":7,"input":"Hello {v1}"}])
        self.assertIn('JSON array',seen[0][1])
        class BrokenClient:
            def generate(self,*args):return '[{"id":7,"output":"formula lost"}]'
        with self.assertRaisesRegex(TranslationFailure,'invalid_batch_translation'):
            translate_batch(BrokenClient(),prompt,'en','zh')


if __name__ == "__main__":
    try: unittest.main()
    finally: cache.cleanup()
