#!/usr/bin/env python3
"""Feature comparison between Rust and TypeScript Elm LSP servers"""

import subprocess
import json
import os
import time
import threading
import queue
import re

# Paths
RUST_LSP = "./target/release/elm_lsp"
TS_LSP = os.path.expanduser("~/projects/elm-lsp-plugin/server/node_modules/@charlontank/elm-language-server/out/node/index.js")

# Use a real file from cleemo-lamdera project
CLEEMO_DIR = os.path.expanduser("~/projects/cleemo-lamdera")
REAL_FILE = os.path.join(CLEEMO_DIR, "src/Frontend.elm")

# Simple test file
ELM_SOURCE = '''module Test exposing (main, greet, User, Status(..))

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

def test_lsp(name, cmd, uri, root_uri=None, source=None):
    """Test LSP server features and return results"""
    results = {}

    env = os.environ.copy()
    env["RUST_LOG"] = "error"

    proc = subprocess.Popen(
        cmd,
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
        # Initialize with rootUri for TypeScript LSP
        init_params = {"capabilities": {}}
        if root_uri:
            init_params["rootUri"] = root_uri
            init_params["rootPath"] = root_uri.replace("file://", "")
        msg = encode_lsp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": init_params})
        proc.stdin.write(msg)
        proc.stdin.flush()
        resp = response_queue.get(timeout=10)
        results["capabilities"] = resp.get("result", {}).get("capabilities", {})

        # Initialized
        msg = encode_lsp({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(0.1)

        # didOpen
        text_content = source if source else ELM_SOURCE
        msg = encode_lsp({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {"uri": uri, "languageId": "elm", "version": 1, "text": text_content}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        time.sleep(0.5)

        # documentSymbol
        msg = encode_lsp({"jsonrpc": "2.0", "id": 2, "method": "textDocument/documentSymbol", "params": {
            "textDocument": {"uri": uri}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        try:
            resp = response_queue.get(timeout=5)
            symbols = resp.get("result", [])
            results["documentSymbol"] = [{"name": s.get("name"), "kind": s.get("kind")} for s in (symbols or [])]
        except queue.Empty:
            results["documentSymbol"] = "TIMEOUT"

        # hover on 'greet' function (line 17, char 0)
        msg = encode_lsp({"jsonrpc": "2.0", "id": 3, "method": "textDocument/hover", "params": {
            "textDocument": {"uri": uri},
            "position": {"line": 16, "character": 0}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        try:
            resp = response_queue.get(timeout=5)
            hover = resp.get("result")
            if hover:
                contents = hover.get("contents", {})
                if isinstance(contents, dict):
                    results["hover_greet"] = contents.get("value", "")[:100]
                else:
                    results["hover_greet"] = str(contents)[:100]
            else:
                results["hover_greet"] = None
        except queue.Empty:
            results["hover_greet"] = "TIMEOUT"

        # hover on 'User' type (line 6, char 11)
        msg = encode_lsp({"jsonrpc": "2.0", "id": 4, "method": "textDocument/hover", "params": {
            "textDocument": {"uri": uri},
            "position": {"line": 5, "character": 11}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        try:
            resp = response_queue.get(timeout=5)
            hover = resp.get("result")
            if hover:
                contents = hover.get("contents", {})
                if isinstance(contents, dict):
                    results["hover_User"] = contents.get("value", "")[:100]
                else:
                    results["hover_User"] = str(contents)[:100]
            else:
                results["hover_User"] = None
        except queue.Empty:
            results["hover_User"] = "TIMEOUT"

        # completion after "greet" (line 23, after the space)
        msg = encode_lsp({"jsonrpc": "2.0", "id": 5, "method": "textDocument/completion", "params": {
            "textDocument": {"uri": uri},
            "position": {"line": 22, "character": 10}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        try:
            resp = response_queue.get(timeout=10)
            comp = resp.get("result")
            if isinstance(comp, list):
                results["completion_count"] = len(comp)
                results["completion_sample"] = [c.get("label") for c in comp[:5]]
            elif isinstance(comp, dict):
                items = comp.get("items", [])
                results["completion_count"] = len(items)
                results["completion_sample"] = [c.get("label") for c in items[:5]]
            else:
                results["completion_count"] = 0
                results["completion_sample"] = []
        except queue.Empty:
            results["completion_count"] = "TIMEOUT"
            results["completion_sample"] = []

        # definition on 'greet' call (line 23)
        msg = encode_lsp({"jsonrpc": "2.0", "id": 6, "method": "textDocument/definition", "params": {
            "textDocument": {"uri": uri},
            "position": {"line": 22, "character": 10}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        try:
            resp = response_queue.get(timeout=5)
            defn = resp.get("result")
            if defn:
                if isinstance(defn, list) and len(defn) > 0:
                    results["definition"] = f"line {defn[0].get('range', {}).get('start', {}).get('line')}"
                elif isinstance(defn, dict):
                    results["definition"] = f"line {defn.get('range', {}).get('start', {}).get('line')}"
                else:
                    results["definition"] = str(defn)[:50]
            else:
                results["definition"] = None
        except queue.Empty:
            results["definition"] = "TIMEOUT"

        # references on 'greet' (line 17)
        msg = encode_lsp({"jsonrpc": "2.0", "id": 7, "method": "textDocument/references", "params": {
            "textDocument": {"uri": uri},
            "position": {"line": 16, "character": 0},
            "context": {"includeDeclaration": True}
        }})
        proc.stdin.write(msg)
        proc.stdin.flush()
        try:
            resp = response_queue.get(timeout=5)
            refs = resp.get("result")
            results["references_count"] = len(refs) if refs else 0
        except queue.Empty:
            results["references_count"] = "TIMEOUT"

    except Exception as e:
        results["error"] = str(e)
    finally:
        stop_event.set()
        try:
            proc.terminate()
            proc.wait(timeout=1)
        except:
            proc.kill()
        reader.join(timeout=1)

    return results

def print_comparison(rust, ts):
    print("\n" + "=" * 70)
    print("  Feature Comparison: Rust vs TypeScript Elm LSP")
    print("=" * 70)

    # Capabilities
    print("\n--- Server Capabilities ---")
    caps = ["hoverProvider", "definitionProvider", "referencesProvider", "documentSymbolProvider",
            "completionProvider", "renameProvider", "codeActionProvider", "documentFormattingProvider"]
    for cap in caps:
        rust_has = "Yes" if rust.get("capabilities", {}).get(cap) else "No"
        ts_has = "Yes" if ts.get("capabilities", {}).get(cap) else "No"
        status = "SAME" if rust_has == ts_has else ("RUST" if rust_has == "Yes" else "TS")
        print(f"  {cap:30s}: Rust={rust_has:4s} TS={ts_has:4s}  [{status}]")

    # Document Symbols
    print("\n--- Document Symbols ---")
    rust_syms = rust.get("documentSymbol", [])
    ts_syms = ts.get("documentSymbol", [])
    print(f"  Rust found: {len(rust_syms) if isinstance(rust_syms, list) else rust_syms}")
    if isinstance(rust_syms, list):
        for s in rust_syms:
            print(f"    - {s['name']} (kind={s['kind']})")
    print(f"  TypeScript found: {len(ts_syms) if isinstance(ts_syms, list) else ts_syms}")
    if isinstance(ts_syms, list):
        for s in ts_syms[:10]:
            print(f"    - {s['name']} (kind={s['kind']})")
        if len(ts_syms) > 10:
            print(f"    ... and {len(ts_syms) - 10} more")

    # Hover
    print("\n--- Hover ---")
    print(f"  Rust hover on 'greet': {rust.get('hover_greet', 'N/A')}")
    print(f"  TS hover on 'greet':   {ts.get('hover_greet', 'N/A')}")
    print(f"  Rust hover on 'User':  {rust.get('hover_User', 'N/A')}")
    print(f"  TS hover on 'User':    {ts.get('hover_User', 'N/A')}")

    # Completion
    print("\n--- Completion ---")
    print(f"  Rust completion count: {rust.get('completion_count', 'N/A')}")
    print(f"  Rust sample: {rust.get('completion_sample', [])}")
    print(f"  TS completion count: {ts.get('completion_count', 'N/A')}")
    print(f"  TS sample: {ts.get('completion_sample', [])}")

    # Definition
    print("\n--- Go to Definition ---")
    print(f"  Rust definition: {rust.get('definition', 'N/A')}")
    print(f"  TS definition:   {ts.get('definition', 'N/A')}")

    # References
    print("\n--- Find References ---")
    print(f"  Rust references: {rust.get('references_count', 'N/A')}")
    print(f"  TS references:   {ts.get('references_count', 'N/A')}")

def main():
    print("=" * 70)
    print("  Testing Elm LSP Features: Rust vs TypeScript")
    print("=" * 70)

    # Test with simple in-memory file first
    simple_uri = "file:///test/Test.elm"
    print("\n--- Test 1: Simple in-memory file ---")

    print("\nTesting Rust LSP (simple file)...")
    rust_simple = test_lsp("Rust", [RUST_LSP], simple_uri)

    print("Testing TypeScript LSP (simple file)...")
    ts_simple = test_lsp("TypeScript", ["node", TS_LSP, "--stdio"], simple_uri)

    print_comparison(rust_simple, ts_simple)

    # Test with real project file
    if os.path.exists(REAL_FILE):
        print("\n\n--- Test 2: Real project file (cleemo-lamdera/src/Frontend.elm) ---")
        real_uri = f"file://{REAL_FILE}"
        root_uri = f"file://{CLEEMO_DIR}"

        with open(REAL_FILE, 'r') as f:
            real_source = f.read()

        print(f"\nReal file size: {len(real_source)} bytes")

        print("\nTesting Rust LSP (real file)...")
        rust_real = test_lsp("Rust", [RUST_LSP], real_uri, source=real_source)

        print("Testing TypeScript LSP (real file with rootUri)...")
        ts_real = test_lsp("TypeScript", ["node", TS_LSP, "--stdio"], real_uri, root_uri=root_uri, source=real_source)

        print_comparison(rust_real, ts_real)
    else:
        print(f"\nSkipping real file test - {REAL_FILE} not found")

if __name__ == "__main__":
    main()
