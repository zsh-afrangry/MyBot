# Offline Responses transport tests, no keys or network. Development owner: docs/22.
import json
from pathlib import Path
import sys
import tempfile
import unittest
import io
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "plugins/kurumi-papers/python"))
from responses import ResponsesClient, TranslationFailure, KEY_IDS, read_response_stream

PROFILE={"provider":"openai","channel":"naiccc","model":"gpt-6.1-sol","effort":"max","protocol":"responses","baseUrl":"https://naiccc.com/v1"}
DS_PROFILE={"provider":"deepseek","channel":"official","model":"deepseek-flash","effort":"none","protocol":"responses","baseUrl":"https://api.deepseek.com"}
KEYS=dict(zip(KEY_IDS,("synthetic-014","synthetic-030","synthetic-040")))
def success(text="译文 {v1}"):
    return 200,{"id":"response-test","status":"completed","model":"gpt-6.1-sol","usage":{"input_tokens":9,"output_tokens":8},"output":[{"type":"reasoning","text":"NEVER EXPOSE"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}]}

class ResponsesTest(unittest.TestCase):
    def client(self,request,**kwargs):
        return ResponsesClient(PROFILE,KEYS,request=request,sleep=lambda n:None,**kwargs)

    def test_deepseek_native_responses_keeps_instructions_effort_usage_and_its_own_key(self):
        seen=[]
        def request(url,key,body,timeout):
            seen.append((url,key,body))
            status,data=success("神经网络")
            data.update(model=body['model'],reasoning={'effort':body['reasoning']['effort']})
            data['usage']['input_tokens_details']={'cached_tokens':3}
            stream='data: '+json.dumps({'type':'response.output_text.delta','delta':'ignored-partial'})+'\n\n'
            stream+='data: '+json.dumps({'type':'response.completed','response':data})+'\n\n'
            return status,read_response_stream(io.BytesIO(stream.encode()))
        for model in ('deepseek-flash','deepseek-v4-pro'):
            for effort in ('none','low','high','max'):
                client=ResponsesClient({**DS_PROFILE,'model':model,'effort':effort},
                    {**KEYS,'DEEPSEEK_API_KEY':'synthetic-official'},request=request)
                self.assertEqual(client.generate('Neural networks','Translate into Chinese.'),'神经网络')
                url,key,body=seen[-1]
                self.assertEqual(url,'https://api.deepseek.com/responses')
                self.assertEqual(key,'synthetic-official')
                self.assertEqual(body['instructions'],'Translate into Chinese.')
                self.assertEqual(body['reasoning'],{'effort':effort})
                self.assertNotIn('messages',body);self.assertNotIn('previous_response_id',body)
                receipt=client.snapshot()['receipts'][0]
                self.assertEqual(receipt['usage']['input_tokens_details']['cached_tokens'],3)
                self.assertEqual(receipt['credentialId'],'DEEPSEEK_API_KEY')
                self.assertNotIn('synthetic-official',json.dumps(client.snapshot()))
        client.generate('JSON input','Return JSON.',output_format={'type':'json_schema','name':'test','schema':{'type':'object'}})
        self.assertEqual(seen[-1][2]['text']['format']['type'],'json_schema')
        self.assertEqual(client.receipts[-1]['outputFormat'],'json_schema')

    def test_deepseek_failure_cannot_fall_back_to_gpt_or_leak_the_gpt_pool(self):
        used=[]
        client=ResponsesClient(DS_PROFILE,{**KEYS,'DEEPSEEK_API_KEY':'synthetic-official'},
            request=lambda url,key,*args:(used.append((url,key)) or (503,{})))
        with self.assertRaisesRegex(TranslationFailure,'all_translation_channels_failed'):client.generate('x','i')
        self.assertEqual(used,[('https://api.deepseek.com/responses','synthetic-official')])
        with self.assertRaisesRegex(TranslationFailure,'missing_translation_credentials'):
            ResponsesClient(DS_PROFILE,KEYS)
        with self.assertRaisesRegex(TranslationFailure,'missing_translation_credentials'):
            ResponsesClient(PROFILE,{'DEEPSEEK_API_KEY':'synthetic-official'})

    def test_worker_rejects_cross_provider_endpoints_models_and_efforts_before_a_request(self):
        for change in ({'baseUrl':'https://attacker.example'},{'baseUrl':'https://naiccc.com/v1'},
                       {'protocol':'chat'},{'model':'gpt-6.1-sol'},{'channel':'naiccc'},{'effort':'medium'}):
            with self.assertRaises(TranslationFailure):
                ResponsesClient({**DS_PROFILE,**change},{**KEYS,'DEEPSEEK_API_KEY':'synthetic-official'})

    def test_native_protocol_and_usage(self):
        seen=[]
        def request(url,key,body,timeout):seen.append(body);return success()
        client=self.client(request)
        self.assertEqual(client.generate("text {v1}","translate",preserve_placeholders=True),"译文 {v1}")
        self.assertEqual(seen[0]["instructions"],"translate")
        self.assertEqual(seen[0]["reasoning"],{"effort":"max"})
        self.assertFalse(seen[0]["store"])
        self.assertTrue(seen[0]["stream"])
        self.assertNotIn("messages",seen[0])
        self.assertNotIn("previous_response_id",seen[0])
        self.assertEqual(client.snapshot()["reportedTokens"],17)
        self.assertNotIn("synthetic-014",json.dumps(client.snapshot()))

    def test_credential_fallback_and_shared_cooldown(self):
        used=[]
        def request(url,key,*args):
            used.append(key)
            return (401,{}) if key.endswith("014") else (429,{"error":{"code":"insufficient_quota"}}) if key.endswith("030") else success()
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/"cooldowns.json"
            self.client(request,cooldown_file=file).generate("x","i")
            self.assertEqual(used,list(KEYS.values()))
            used.clear();self.client(request,cooldown_file=file).generate("x","i")
            self.assertEqual(used,[KEYS[KEY_IDS[2]]])
            self.assertNotIn("synthetic",file.read_text())

    def test_parameter_and_parse_failures_do_not_rotate(self):
        for status,data in [(400,{}),(403,{"error":{"code":"non_json_http_error"}}),(200,{"status":"incomplete"}),(200,{})]:
            used=[]
            client=self.client(lambda url,key,*a:(used.append(key) or (status,data)))
            with self.assertRaises(TranslationFailure):client.generate("x","i")
            self.assertEqual(used,[KEYS[KEY_IDS[0]]])

    def test_boolean_usage_is_not_a_token_count(self):
        status,data=success();data["usage"]["input_tokens"]=True
        with self.assertRaisesRegex(TranslationFailure,"usage_unknown"):
            self.client(lambda *a:(status,data)).generate("x","i")

    def test_limits_count_all_attempts_and_failure_stays_terminal(self):
        client=self.client(lambda *a:success(),max_requests=1)
        client.generate("x","i")
        with self.assertRaisesRegex(TranslationFailure,"budget"):client.generate("x","i")
        self.assertEqual(client.requests,1)
        calls=[]
        client=self.client(lambda *a:(calls.append(1) or (502,{})))
        with self.assertRaisesRegex(TranslationFailure,"all_translation_channels_failed"):client.generate("x","i")
        with self.assertRaises(TranslationFailure):client.generate("x","i")
        self.assertEqual(len(calls),3)

    def test_empty_reasoning_refusal_wrong_model_and_formula_loss_are_errors(self):
        for modify in (lambda d:d.update(output=[{"type":"reasoning"}]),lambda d:d.update(model="other"),lambda d:d.update(status="incomplete"),lambda d:d.update(output=[{"type":"message","role":"assistant","content":[{"type":"refusal"}]}])):
            _,data=success();modify(data)
            with self.assertRaises(TranslationFailure):self.client(lambda *a:(200,data)).generate("x","i")
        with self.assertRaisesRegex(TranslationFailure,"placeholder"):
            self.client(lambda *a:success("no formula")).generate("x {v1}","i",preserve_placeholders=True)

    def test_transport_uncertainty_visits_each_channel_once_then_stays_terminal(self):
        def request(*a):raise TranslationFailure("api_transport_unknown")
        client=self.client(request)
        with self.assertRaisesRegex(TranslationFailure,"all_translation_channels_failed"):client.generate("x","i")
        self.assertEqual(client.requests,3)
        self.assertEqual(client.snapshot()['unknownUsageAttempts'],3)
        self.assertEqual([r['credentialId'] for r in client.receipts],list(KEY_IDS))
        with self.assertRaises(TranslationFailure):client.generate("x","i")
        self.assertEqual(client.requests,3)

    def test_empty_capability_probe_cannot_reach_the_api(self):
        used=[]
        client=self.client(lambda *a:(used.append(1) or success()))
        with self.assertRaisesRegex(TranslationFailure,"invalid_translation_input"):
            client.generate(None,"i")
        self.assertEqual(used,[])

    def test_stream_needs_completed_response_and_ignores_partial_reasoning(self):
        _,data=success()
        stream='data: '+json.dumps({'type':'response.reasoning_summary_text.delta','delta':'private'})+'\n\n'
        stream+='data: '+json.dumps({'type':'response.completed','response':data})+'\n\n'
        self.assertEqual(read_response_stream(io.BytesIO(stream.encode())),data)
        for incomplete in ['data: [DONE]\n\n','data: '+json.dumps({'type':'response.output_text.delta','delta':'partial'})+'\n\n']:
            with self.assertRaisesRegex(TranslationFailure,'interrupted_unknown'):
                read_response_stream(io.BytesIO(incomplete.encode()))

    def test_stream_errors_keep_only_safe_machine_codes(self):
        data={'type':'error','code':'upstream_error','message':'synthetic-secret and private document'}
        stream='data: '+json.dumps(data)+'\n\n'
        with self.assertRaises(TranslationFailure) as caught:
            read_response_stream(io.BytesIO(stream.encode()))
        self.assertEqual(caught.exception.details,{'apiErrorCode':'upstream_error','apiErrorType':'error'})
        def fail(*args):raise caught.exception
        client=self.client(fail)
        with self.assertRaisesRegex(TranslationFailure,'all_translation_channels_failed'):client.generate('x','i')
        snapshot=json.dumps(client.snapshot())
        self.assertIn('upstream_error',snapshot)
        self.assertNotIn('synthetic-secret',snapshot)
        self.assertNotIn('private document',snapshot)

    def test_auth_and_quota_errors_in_http200_streams_use_the_same_fallback(self):
        used=[]
        def request(url,key,*args):
            used.append(key)
            if key.endswith('040'):return success()
            code='invalid_api_key' if key.endswith('014') else 'insufficient_quota'
            stream='data: '+json.dumps({'type':'error','code':code})+'\n\n'
            return 200,read_response_stream(io.BytesIO(stream.encode()))
        client=self.client(request)
        client.generate('x','i')
        self.assertEqual(used,list(KEYS.values()))
        self.assertEqual(client.receipts[0]['httpStatus'],200)
        self.assertEqual(client.receipts[0]['apiErrorCode'],'invalid_api_key')

    def test_upstream_stream_failure_rotates_in_order_and_cools_independent_channels(self):
        used=[];bodies=[]
        def request(url,key,body,timeout):
            used.append(key);bodies.append(body)
            if key.endswith('040'):return success()
            events=[{'type':'response.output_text.delta','delta':'DISCARD PARTIAL'},
                    {'type':'error','code':'upstream_stream_read_error'}]
            stream=''.join('data: '+json.dumps(e)+'\n\n' for e in events)
            return 200,read_response_stream(io.BytesIO(stream.encode()))
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'cooldowns.json'
            c=self.client(request,cooldown_file=file)
            self.assertEqual(c.generate('text {v1}','translate',preserve_placeholders=True),'译文 {v1}')
            self.assertEqual(used,list(KEYS.values()))
            self.assertEqual(c.snapshot()['unknownUsageAttempts'],2)
            self.assertEqual(c.snapshot()['reportedTokens'],17)
            self.assertIsNone(c.failure)
            self.assertTrue(all(b==bodies[0] for b in bodies))
            self.assertNotIn('DISCARD PARTIAL',json.dumps(c.snapshot()))
            used.clear()
            self.client(request,cooldown_file=file).generate('x','i')
            self.assertEqual(used,[KEYS[KEY_IDS[2]]])
            self.assertNotIn('synthetic-',file.read_text())

    def test_transient_http_and_failed_terminal_events_reach_next_channel(self):
        for status in (408,500,502,503,504,520,522,524,529):
            used=[]
            def request(url,key,*a):
                used.append(key)
                return (status,{}) if key.endswith('014') else success()
            c=self.client(request);c.generate('x','i')
            self.assertEqual(used,list(KEYS.values())[:2])
            self.assertEqual(c.snapshot()['unknownUsageAttempts'],1)
        used=[]
        def request(url,key,*a):
            used.append(key)
            if not key.endswith('014'):return success()
            return 200,{'status':'failed','error':{'code':'upstream_stream_read_error'},
                        'usage':{'input_tokens':3,'output_tokens':2}}
        c=self.client(request);c.generate('x','i')
        self.assertEqual(c.snapshot()['reportedTokens'],22)
        self.assertEqual(c.snapshot()['unknownUsageAttempts'],0)

    def test_unknown_or_permanent_errors_do_not_hide_behind_channel_rotation(self):
        for code in ('bad_request','content_policy_violation','unrecognized_error'):
            used=[]
            def request(url,key,*a):
                used.append(key)
                raise TranslationFailure('api_stream_error',{'apiErrorCode':code})
            c=self.client(request)
            with self.assertRaisesRegex(TranslationFailure,'api_stream_error'):c.generate('x','i')
            self.assertEqual(used,[KEYS[KEY_IDS[0]]])

    def test_failover_respects_global_request_and_reported_token_limits(self):
        used=[]
        def request(url,key,*a):
            used.append(key);raise TranslationFailure('api_stream_interrupted_unknown')
        c=self.client(request,max_requests=2)
        with self.assertRaisesRegex(TranslationFailure,'budget_exhausted'):c.generate('x','i')
        self.assertEqual(used,list(KEYS.values())[:2])
        self.assertEqual(c.snapshot()['unknownUsageAttempts'],2)
        def metered(url,key,*a):
            return 200,{'status':'failed','error':{'code':'upstream_stream_read_error'},
                        'usage':{'input_tokens':10,'output_tokens':10}}
        c=self.client(metered,max_tokens=20)
        with self.assertRaisesRegex(TranslationFailure,'budget_exhausted'):c.generate('x','i')
        self.assertEqual(c.requests,1)

    def test_stream_timeout_uses_next_channel_and_a_cooled_channel_can_recover(self):
        clock=[1000.0];used=[]
        def request(url,key,*a):
            used.append(key)
            if key.endswith('014') and clock[0]<1300:raise TranslationFailure('api_request_timed_out_unknown')
            return success()
        c=self.client(request,now=lambda:clock[0])
        c.generate('x','i');self.assertEqual(used,list(KEYS.values())[:2])
        used.clear();clock[0]=1301;c.generate('y','i')
        self.assertEqual(used,[KEYS[KEY_IDS[0]]])

    def test_rate_limit_has_one_same_channel_retry_then_moves_on(self):
        used=[]
        def request(url,key,*a):
            used.append(key)
            return (429,{'error':{'code':'rate_limit_exceeded'}}) if key.endswith('014') else success()
        c=self.client(request);c.generate('x','i')
        self.assertEqual(used,[KEYS[KEY_IDS[0]],KEYS[KEY_IDS[0]],KEYS[KEY_IDS[1]]])

if __name__=="__main__":unittest.main()
