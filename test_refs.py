#!/usr/bin/env python3
"""Test cross-file references"""

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
    print("  Testing Cross-File References")
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

        print("\nWaiting for workspace indexing...")
        time.sleep(3)

        # Open DomId.elm which has symbols used across the codebase
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

        # Find a specific function in DomId.elm
        # Let's look for "loginEmail" which is likely used in multiple places
        lines = content.split('\n')
        target_line = None
        target_char = 0
        for i, line in enumerate(lines):
            if 'loginEmail' in line and '=' in line:
                target_line = i
                target_char = line.index('loginEmail') if 'loginEmail' in line else 0
                break

        if target_line is not None:
            print(f"\n1. Finding references for 'loginEmail' at line {target_line}...")
            msg = encode_lsp({
                "jsonrpc": "2.0", "id": 2, "method": "textDocument/references",
                "params": {
                    "textDocument": {"uri": uri},
                    "position": {"line": target_line, "character": target_char},
                    "context": {"includeDeclaration": True}
                }
            })
            proc.stdin.write(msg)
            proc.stdin.flush()

            resp = wait_for_response(response_queue, 2, timeout=10)
            if resp:
                refs = resp.get("result", [])
                print(f"   Found {len(refs) if refs else 0} references")
                if refs:
                    # Group by file
                    by_file = {}
                    for r in refs:
                        fname = os.path.basename(r["uri"])
                        by_file.setdefault(fname, []).append(r)
                    for fname, file_refs in sorted(by_file.items())[:5]:
                        print(f"   - {fname}: {len(file_refs)} references")
            else:
                print("   Timeout")

        # Test with a more common symbol - "id" from DomId
        print("\n2. Finding references for 'id' function...")
        # Find the 'id' function
        for i, line in enumerate(lines):
            if line.startswith('id ') or line.startswith('id :'):
                target_line = i
                target_char = 0
                break

        msg = encode_lsp({
            "jsonrpc": "2.0", "id": 3, "method": "textDocument/references",
            "params": {
                "textDocument": {"uri": uri},
                "position": {"line": target_line, "character": target_char},
                "context": {"includeDeclaration": True}
            }
        })
        proc.stdin.write(msg)
        proc.stdin.flush()

        resp = wait_for_response(response_queue, 3, timeout=10)
        if resp:
            refs = resp.get("result", [])
            print(f"   Found {len(refs) if refs else 0} references")

        # Test rename
        print("\n3. Testing rename for 'loginEmail'...")
        for i, line in enumerate(lines):
            if 'loginEmail' in line and '=' in line:
                target_line = i
                target_char = line.index('loginEmail')
                break

        msg = encode_lsp({
            "jsonrpc": "2.0", "id": 4, "method": "textDocument/rename",
            "params": {
                "textDocument": {"uri": uri},
                "position": {"line": target_line, "character": target_char},
                "newName": "loginEmailField"
            }
        })
        proc.stdin.write(msg)
        proc.stdin.flush()

        resp = wait_for_response(response_queue, 4, timeout=10)
        if resp:
            result = resp.get("result")
            if result and result.get("changes"):
                changes = result["changes"]
                print(f"   Rename would affect {len(changes)} files:")
                total_edits = 0
                for file_uri, edits in sorted(changes.items())[:10]:
                    fname = os.path.basename(file_uri)
                    total_edits += len(edits)
                    print(f"   - {fname}: {len(edits)} edits")
                if len(changes) > 10:
                    print(f"   ... and {len(changes) - 10} more files")
                print(f"   Total: {total_edits} edits across {len(changes)} files")
            else:
                print("   No changes")
        else:
            print("   Timeout")

    finally:
        stop_event.set()
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except:
            proc.kill()

        stderr = proc.stderr.read()
        # Show relevant logs
        print("\n--- Server Logs ---")
        for line in stderr.split('\n')[-15:]:
            if any(x in line for x in ['modules', 'symbols', 'Rename', 'references', 'Finding']):
                if 'INFO' in line:
                    msg = line.split('INFO')[-1].strip()
                    print(f"  {msg[:100]}")

        reader.join(timeout=1)

    print("\n" + "=" * 70)

if __name__ == "__main__":
    main()
