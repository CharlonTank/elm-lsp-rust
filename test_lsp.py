#!/usr/bin/env python3
"""Test script for Rust Elm LSP server"""

import subprocess
import json
import sys
import re
import os
import time
import threading
import queue

def encode_lsp(obj):
    """Encode a JSON-RPC message with LSP headers"""
    content = json.dumps(obj)
    return f"Content-Length: {len(content)}\r\n\r\n{content}"

def read_responses(stdout, response_queue, stop_event):
    """Read responses from the server in a separate thread"""
    buffer = ""
    while not stop_event.is_set():
        try:
            chunk = stdout.read(1)
            if not chunk:
                break
            buffer += chunk

            # Try to parse complete messages
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

def main():
    # Test Elm source code
    elm_source = '''module Test exposing (main, greet)

import Html exposing (Html, text)


type alias User =
    { name : String
    , age : Int
    }


type Status
    = Active
    | Inactive


greet : String -> String
greet name =
    "Hello, " ++ name ++ "!"


main : Html msg
main =
    text (greet "World")
'''

    uri = "file:///test.elm"

    print("=" * 60)
    print("Testing Rust Elm LSP Server")
    print("=" * 60)

    # Run the LSP server with logging enabled
    env = os.environ.copy()
    env["RUST_LOG"] = "info"

    proc = subprocess.Popen(
        ["./target/release/elm_lsp"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env
    )

    response_queue = queue.Queue()
    stop_event = threading.Event()
    reader_thread = threading.Thread(target=read_responses, args=(proc.stdout, response_queue, stop_event))
    reader_thread.start()

    try:
        # Send initialize
        msg = encode_lsp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"capabilities": {}}})
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(0.3)

        # Send initialized
        msg = encode_lsp({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(0.3)

        # Open document
        msg = encode_lsp({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {"uri": uri, "languageId": "elm", "version": 1, "text": elm_source}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(0.5)

        # Request document symbols
        msg = encode_lsp({"jsonrpc": "2.0", "id": 2, "method": "textDocument/documentSymbol", "params": {
            "textDocument": {"uri": uri}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(0.3)

        # Request hover
        msg = encode_lsp({"jsonrpc": "2.0", "id": 3, "method": "textDocument/hover", "params": {
            "textDocument": {"uri": uri},
            "position": {"line": 17, "character": 0}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(0.3)

        # Collect responses
        responses = []
        try:
            while True:
                resp = response_queue.get(timeout=0.5)
                responses.append(resp)
        except queue.Empty:
            pass

        # Print stderr (server logs)
        stop_event.set()
        proc.terminate()
        try:
            proc.wait(timeout=1)
        except:
            proc.kill()

        stderr = proc.stderr.read()
        if stderr:
            print("\nServer logs:")
            print(stderr[:3000])

        print(f"\nReceived {len(responses)} responses:\n")

        for resp in responses:
            if "id" not in resp:
                continue
            req_id = resp["id"]
            if req_id == 1:
                print("1. INITIALIZE RESPONSE:")
                caps = resp.get("result", {}).get("capabilities", {})
                print(f"   - Hover: {caps.get('hoverProvider', False)}")
                print(f"   - Definition: {caps.get('definitionProvider', False)}")
                print(f"   - References: {caps.get('referencesProvider', False)}")
                print(f"   - Symbols: {caps.get('documentSymbolProvider', False)}")
                print(f"   - Completion: {caps.get('completionProvider', {})}")
                print(f"   - Rename: {caps.get('renameProvider', {})}")

            elif req_id == 2:
                print("\n2. DOCUMENT SYMBOLS:")
                symbols = resp.get("result", [])
                if symbols:
                    for sym in symbols:
                        kind_map = {12: "Function", 23: "Struct", 10: "Enum", 11: "Interface"}
                        kind = kind_map.get(sym.get("kind"), sym.get("kind"))
                        print(f"   - {sym['name']} ({kind})")
                else:
                    print("   No symbols found")

            elif req_id == 3:
                print("\n3. HOVER RESPONSE:")
                result = resp.get("result")
                if result:
                    contents = result.get("contents", {})
                    if isinstance(contents, dict):
                        val = contents.get('value', 'No content')
                        print(f"   {val[:200]}")
                    else:
                        print(f"   {str(contents)[:200] if contents else 'No content'}")
                else:
                    print("   No hover info")

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        stop_event.set()
        try:
            proc.terminate()
            proc.wait(timeout=1)
        except:
            proc.kill()
        reader_thread.join(timeout=1)

    print("\n" + "=" * 60)
    print("Test complete!")
    print("=" * 60)

if __name__ == "__main__":
    main()
