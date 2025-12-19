#!/usr/bin/env python3
"""Test workspace indexing with cleemo-lamdera project"""

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
    """Wait for a response with specific ID"""
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = q.get(timeout=1)
            if r.get("id") == id:
                return r
            # Print notifications
            if "method" in r:
                print(f"  [notification] {r.get('method')}")
        except queue.Empty:
            continue
    return None

def main():
    print("=" * 70)
    print("  Testing Rust Elm LSP with Workspace Indexing")
    print("=" * 70)
    print(f"\nProject: {CLEEMO_DIR}")

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
        # Initialize with rootUri
        print("\n1. Initializing with workspace...")
        msg = encode_lsp({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": os.getpid(),
                "rootUri": f"file://{CLEEMO_DIR}",
                "capabilities": {}
            }
        })
        proc.stdin.write(msg)
        proc.stdin.flush()

        resp = wait_for_response(response_queue, 1)
        if resp:
            caps = resp.get("result", {}).get("capabilities", {})
            print(f"   Capabilities: hover={caps.get('hoverProvider')}, def={caps.get('definitionProvider')}, refs={caps.get('referencesProvider')}")

        # Initialized
        msg = encode_lsp({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        proc.stdin.write(msg)
        proc.stdin.flush()

        # Wait for indexing
        print("\n2. Waiting for workspace indexing...")
        time.sleep(3)

        # Test workspace symbol search
        print("\n3. Testing workspace symbol search for 'update'...")
        msg = encode_lsp({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "workspace/symbol",
            "params": {"query": "update"}
        })
        proc.stdin.write(msg)
        proc.stdin.flush()

        resp = wait_for_response(response_queue, 2, timeout=10)
        if resp and resp.get("result"):
            symbols = resp["result"]
            print(f"   Found {len(symbols)} symbols matching 'update'")
            for s in symbols[:5]:
                print(f"   - {s['name']} in {s.get('containerName', 'unknown')}")
            if len(symbols) > 5:
                print(f"   ... and {len(symbols) - 5} more")
        else:
            print("   No symbols found or timeout")

        # Test cross-file definition
        print("\n4. Testing cross-file go-to-definition...")
        # Open a file first
        test_file = os.path.join(CLEEMO_DIR, "src/Frontend.elm")
        if os.path.exists(test_file):
            with open(test_file, 'r') as f:
                content = f.read()

            uri = f"file://{test_file}"
            msg = encode_lsp({
                "jsonrpc": "2.0",
                "method": "textDocument/didOpen",
                "params": {
                    "textDocument": {"uri": uri, "languageId": "elm", "version": 1, "text": content}
                }
            })
            proc.stdin.write(msg)
            proc.stdin.flush()
            time.sleep(0.5)

            # Try to find definition of a cross-file symbol
            msg = encode_lsp({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "textDocument/definition",
                "params": {
                    "textDocument": {"uri": uri},
                    "position": {"line": 10, "character": 10}  # Arbitrary position
                }
            })
            proc.stdin.write(msg)
            proc.stdin.flush()

            resp = wait_for_response(response_queue, 3, timeout=5)
            if resp:
                result = resp.get("result")
                if result:
                    print(f"   Definition found: {result}")
                else:
                    print("   No definition at that position")
            else:
                print("   Timeout")

        # Test references
        print("\n5. Testing find references...")
        msg = encode_lsp({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "textDocument/references",
            "params": {
                "textDocument": {"uri": f"file://{test_file}"},
                "position": {"line": 50, "character": 5},
                "context": {"includeDeclaration": True}
            }
        })
        proc.stdin.write(msg)
        proc.stdin.flush()

        resp = wait_for_response(response_queue, 4, timeout=5)
        if resp:
            refs = resp.get("result", [])
            print(f"   Found {len(refs) if refs else 0} references")
        else:
            print("   Timeout")

    finally:
        stop_event.set()
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except:
            proc.kill()

        # Print server logs
        stderr = proc.stderr.read()
        if stderr:
            print("\n--- Server Logs ---")
            # Show last 2000 chars
            lines = stderr.split('\n')
            for line in lines[-30:]:
                if 'INFO' in line or 'ERROR' in line or 'WARN' in line:
                    # Extract just the message part
                    if 'INFO' in line:
                        msg = line.split('INFO')[-1].strip()
                        print(f"  [INFO] {msg[:100]}")
                    elif 'ERROR' in line:
                        msg = line.split('ERROR')[-1].strip()
                        print(f"  [ERROR] {msg[:100]}")

        reader.join(timeout=1)

    print("\n" + "=" * 70)
    print("  Test complete!")
    print("=" * 70)

if __name__ == "__main__":
    main()
