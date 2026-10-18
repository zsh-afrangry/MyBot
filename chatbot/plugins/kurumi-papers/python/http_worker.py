"""One cancellable HTTP attempt. Private anonymous-pipe protocol; development owner: docs/22.

Launched only by responses.http_request inside the existing translation sandbox. Exits after
one response; never opens a listener, writes a file or logs request/response/exception text.
"""
import json
import sys
from responses import blocking_http_request, TranslationFailure


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    try:
        request = json.load(sys.stdin)
        status, value = blocking_http_request(request["url"], request["key"], request["body"], request["timeout"],
            on_progress=lambda value: emit({"kind": "progress", "value": value}),
            on_output=lambda at: emit({"kind": "output_activity", "at": at}))
        emit({"kind": "result", "status": status, "value": value})
    except TranslationFailure as error:
        emit({"kind": "failure", "code": str(error), "details": error.details})
    except BaseException as error:
        emit({"kind": "failure", "code": "api_transport_worker_error",
              "details": {"transportExceptionType": type(error).__name__, "transportPhase": "worker"}})


if __name__ == "__main__":
    main()
