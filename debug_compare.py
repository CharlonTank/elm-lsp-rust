#!/usr/bin/env python3
"""Debug LSP responses"""

import subprocess
import json
import os
import time
import threading
import queue
import re

RUST_LSP = "./target/release/elm_lsp"
TS_LSP = os.path.expanduser("~/projects/elm-lsp-plugin/server/node_modules/@charlontank/elm-language-server/out/node/index.js")
CLEEMO_DIR = os.path.expanduser("~/projects/cleemo-lamdera")

ELM_SOURCE = '''module Test exposing (main, greet)

greet : String -> String
greet name =
    "Hello, " ++ name

main =
    greet "World"
'''

def encode_lsp(obj):
    content = json.dumps(obj)
    return f"Content-Length: {len(content)}\r\n\r\n{content}"

def read_responses(stdout, response_queue, stop_event):
    buffer = ""
    while not stop_event.is_set():
        try:
            chunk = stdout.read(1)
            if not chunk:
                break
            buffer += chunk
            while "Content-Length:" in buffer:
                match = re.search(r'Content-Length: (\d+)\r?\n\r?\n', buffer)
                if not match:
                    break
                length = int(match.group(1))
                header_end = match.end()
                if len(buffer) >= header_end + length:
                    content = buffer[header_end:header_end + length]
                    buffer = buffer[header_end + length:]
                    try:
                        response_queue.put(json.loads(content))
                    except:
                        pass
                else:
                    break
        except:
            break

def test_server(name, cmd, root_uri=None):
    print(f"\n{'='*60}")
    print(f"Testing {name}")
    print(f"{'='*60}")

    env = os.environ.copy()
    env["RUST_LOG"] = "info"

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    response_queue = queue.Queue()
    stop_event = threading.Event()
    reader = threading.Thread(target=read_responses, args=(proc.stdout, response_queue, stop_event))
    reader.start()

    try:
        # Initialize
        init_params = {
            "processId": os.getpid(),
            "capabilities": {
                "textDocument": {
                    "hover": {"contentFormat": ["markdown", "plaintext"]},
                    "completion": {"completionItem": {"snippetSupport": True}},
                    "definition": {},
                    "references": {},
                    "documentSymbol": {},
                }
            }
        }
        if root_uri:
            init_params["rootUri"] = root_uri
            init_params["rootPath"] = root_uri.replace("file://", "")

        msg = encode_lsp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": init_params})
        proc.stdin.write(msg)
        proc.stdin.flush()

        # Wait for initialize response (id=1)
        resp = None
        for _ in range(20):
            try:
                r = response_queue.get(timeout=1)
                print(f"  Got message: method={r.get('method', 'response')} id={r.get('id', 'N/A')}")
                if r.get("id") == 1:
                    resp = r
                    break
            except queue.Empty:
                break
        if resp:
            print(f"\n1. Initialize response:")
            print(json.dumps(resp, indent=2)[:2000])
        else:
            print("No initialize response received")
            return

        # Initialized
        msg = encode_lsp({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(0.5)

        # didOpen
        uri = "file:///test/Test.elm"
        msg = encode_lsp({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {"uri": uri, "languageId": "elm", "version": 1, "text": ELM_SOURCE}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(1)

        # documentSymbol
        msg = encode_lsp({"jsonrpc": "2.0", "id": 2, "method": "textDocument/documentSymbol", "params": {
            "textDocument": {"uri": uri}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()

        # Wait for documentSymbol response (id=2)
        resp = None
        for _ in range(10):
            try:
                r = response_queue.get(timeout=1)
                print(f"  Got message: method={r.get('method', 'response')} id={r.get('id', 'N/A')}")
                if r.get("id") == 2:
                    resp = r
                    break
            except queue.Empty:
                break
        if resp:
            print(f"\n2. DocumentSymbol response:")
            print(json.dumps(resp, indent=2)[:1000])
        else:
            print("No documentSymbol response received")

        # Hover
        msg = encode_lsp({"jsonrpc": "2.0", "id": 3, "method": "textDocument/hover", "params": {
            "textDocument": {"uri": uri},
            "position": {"line": 3, "character": 0}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()

        # Wait for hover response (id=3)
        resp = None
        for _ in range(10):
            try:
                r = response_queue.get(timeout=1)
                print(f"  Got message: method={r.get('method', 'response')} id={r.get('id', 'N/A')}")
                if r.get("id") == 3:
                    resp = r
                    break
            except queue.Empty:
                break
        if resp:
            print(f"\n3. Hover response:")
            print(json.dumps(resp, indent=2)[:1000])
        else:
            print("No hover response received")

    finally:
        stop_event.set()
        try:
            proc.terminate()
            proc.wait(timeout=1)
        except:
            proc.kill()
        reader.join(timeout=1)

        stderr = proc.stderr.read()
        if stderr:
            print(f"\nServer stderr (last 500 chars):")
            print(stderr[-500:])

# Test Rust
test_server("Rust LSP", [RUST_LSP])

# Test TypeScript with rootUri
test_server("TypeScript LSP", ["node", TS_LSP, "--stdio"], root_uri=f"file://{CLEEMO_DIR}")
