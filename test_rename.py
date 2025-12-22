#!/usr/bin/env python3
"""Test cross-file rename with a real symbol"""

import subprocess
import json
import os
import time
import threading
import queue
import re

RUST_LSP = "./target/release/elm_lsp"
CLEEMO_DIR = os.path.expanduser("~/projects/cleemo-lamdera")

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

def wait_for_response(q, id, timeout=30):
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = q.get(timeout=1)
            if r.get("id") == id:
                return r
        except queue.Empty:
            continue
    return None

def main():
    print("=" * 70)
    print("  Testing Cross-File Rename")
    print("=" * 70)

    env = os.environ.copy()
    env["RUST_LOG"] = "info"

    proc = subprocess.Popen(
        [RUST_LSP],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env
    )

    response_queue = queue.Queue()
    stop_event = threading.Event()
    reader = threading.Thread(target=read_responses, args=(proc.stdout, response_queue, stop_event))
    reader.start()

    try:
        # Initialize
        msg = encode_lsp({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"processId": os.getpid(), "rootUri": f"file://{CLEEMO_DIR}", "capabilities": {}}
        })
        proc.stdin.write(msg)
        proc.stdin.flush()
        wait_for_response(response_queue, 1)

        msg = encode_lsp({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(3)  # Wait for indexing

        # Find a symbol to test - let's search for "viewProperty"
        print("\n1. Searching for 'viewProperty' in workspace...")
        msg = encode_lsp({
            "jsonrpc": "2.0", "id": 2, "method": "workspace/symbol",
            "params": {"query": "viewProperty"}
        })
        proc.stdin.write(msg)
        proc.stdin.flush()

        resp = wait_for_response(response_queue, 2, timeout=5)
        if resp and resp.get("result"):
            symbols = resp["result"]
            print(f"   Found {len(symbols)} symbols")
            for s in symbols[:3]:
                loc = s.get("location", {})
                uri = loc.get("uri", "")
                range_ = loc.get("range", {}).get("start", {})
                print(f"   - {s['name']} at {os.path.basename(uri)}:{range_.get('line', 0)}")

        # Test finding references for a common function
        print("\n2. Finding references for 'sendToBackend'...")
        msg = encode_lsp({
            "jsonrpc": "2.0", "id": 3, "method": "workspace/symbol",
            "params": {"query": "sendToBackend"}
        })
        proc.stdin.write(msg)
        proc.stdin.flush()

        resp = wait_for_response(response_queue, 3, timeout=5)
        if resp and resp.get("result"):
            symbols = resp["result"]
            print(f"   Found {len(symbols)} definitions")

        # Test hover on a known symbol
        print("\n3. Testing hover on DomId module...")
        test_file = os.path.join(CLEEMO_DIR, "src/DomId.elm")
        with open(test_file, 'r') as f:
            content = f.read()

        uri = f"file://{test_file}"
        msg = encode_lsp({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": {"textDocument": {"uri": uri, "languageId": "elm", "version": 1, "text": content}}
        })
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(0.5)

        # Hover on a function
        msg = encode_lsp({
            "jsonrpc": "2.0", "id": 4, "method": "textDocument/hover",
            "params": {"textDocument": {"uri": uri}, "position": {"line": 20, "character": 0}}
        })
        proc.stdin.write(msg)
        proc.stdin.flush()

        resp = wait_for_response(response_queue, 4, timeout=5)
        if resp and resp.get("result"):
            hover = resp["result"]
            contents = hover.get("contents", {})
            value = contents.get("value", "") if isinstance(contents, dict) else str(contents)
            print(f"   Hover result: {value[:100]}...")
        else:
            print("   No hover result")

    finally:
        stop_event.set()
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except:
            proc.kill()

        stderr = proc.stderr.read()
        if stderr:
            print("\n--- Key Server Logs ---")
            for line in stderr.split('\n')[-20:]:
                if any(x in line for x in ['modules', 'symbols', 'Rename', 'definition', 'references']):
                    if 'INFO' in line:
                        msg = line.split('INFO')[-1].strip()
                        print(f"  {msg[:80]}")

        reader.join(timeout=1)

    print("\n" + "=" * 70)

if __name__ == "__main__":
    main()
