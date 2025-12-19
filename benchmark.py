#!/usr/bin/env python3
"""Benchmark comparison between Rust and TypeScript Elm LSP servers"""

import subprocess
import json
import os
import time
import threading
import queue
import re
import sys

# Paths
RUST_LSP = "./target/release/elm_lsp"
TS_LSP = os.path.expanduser("~/projects/elm-lsp-plugin/server/node_modules/@charlontank/elm-language-server/out/node/index.js")

# Test Elm source - a more realistic file
ELM_SOURCE = '''module Main exposing (main, Model, Msg(..), init, update, view)

import Browser
import Html exposing (Html, div, text, button, input, ul, li, h1, p)
import Html.Attributes exposing (class, value, placeholder, type_)
import Html.Events exposing (onClick, onInput)


type alias Model =
    { todos : List Todo
    , inputText : String
    , filter : Filter
    , nextId : Int
    }


type alias Todo =
    { id : Int
    , text : String
    , completed : Bool
    }


type Filter
    = All
    | Active
    | Completed


type Msg
    = AddTodo
    | UpdateInput String
    | ToggleTodo Int
    | DeleteTodo Int
    | SetFilter Filter
    | ClearCompleted


init : Model
init =
    { todos = []
    , inputText = ""
    , filter = All
    , nextId = 1
    }


update : Msg -> Model -> Model
update msg model =
    case msg of
        AddTodo ->
            if String.isEmpty model.inputText then
                model
            else
                { model
                    | todos = model.todos ++ [ { id = model.nextId, text = model.inputText, completed = False } ]
                    , inputText = ""
                    , nextId = model.nextId + 1
                }

        UpdateInput text ->
            { model | inputText = text }

        ToggleTodo id ->
            { model
                | todos =
                    List.map
                        (\\todo ->
                            if todo.id == id then
                                { todo | completed = not todo.completed }
                            else
                                todo
                        )
                        model.todos
            }

        DeleteTodo id ->
            { model | todos = List.filter (\\todo -> todo.id /= id) model.todos }

        SetFilter filter ->
            { model | filter = filter }

        ClearCompleted ->
            { model | todos = List.filter (\\todo -> not todo.completed) model.todos }


filteredTodos : Filter -> List Todo -> List Todo
filteredTodos filter todos =
    case filter of
        All ->
            todos

        Active ->
            List.filter (\\todo -> not todo.completed) todos

        Completed ->
            List.filter .completed todos


viewTodo : Todo -> Html Msg
viewTodo todo =
    li [ class (if todo.completed then "completed" else "") ]
        [ text todo.text
        , button [ onClick (ToggleTodo todo.id) ] [ text "Toggle" ]
        , button [ onClick (DeleteTodo todo.id) ] [ text "Delete" ]
        ]


view : Model -> Html Msg
view model =
    div [ class "app" ]
        [ h1 [] [ text "Todo App" ]
        , div [ class "input-section" ]
            [ input [ placeholder "What needs to be done?", value model.inputText, onInput UpdateInput ] []
            , button [ onClick AddTodo ] [ text "Add" ]
            ]
        , ul [ class "todo-list" ]
            (List.map viewTodo (filteredTodos model.filter model.todos))
        , div [ class "filters" ]
            [ button [ onClick (SetFilter All) ] [ text "All" ]
            , button [ onClick (SetFilter Active) ] [ text "Active" ]
            , button [ onClick (SetFilter Completed) ] [ text "Completed" ]
            ]
        , button [ onClick ClearCompleted ] [ text "Clear Completed" ]
        , p [] [ text (String.fromInt (List.length (List.filter (\\t -> not t.completed) model.todos)) ++ " items left") ]
        ]


main : Program () Model Msg
main =
    Browser.sandbox
        { init = init
        , update = update
        , view = view
        }
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

def benchmark_lsp(name, cmd, uri, iterations=5):
    """Run benchmark for an LSP server"""
    results = {
        "startup": [],
        "didOpen": [],
        "documentSymbol": [],
        "hover": [],
        "completion": [],
        "definition": [],
        "references": [],
    }

    for i in range(iterations):
        print(f"  Iteration {i+1}/{iterations}...", end=" ", flush=True)

        env = os.environ.copy()
        env["RUST_LOG"] = "error"  # Minimize logging

        # Measure startup
        start = time.time()
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
            # Initialize
            msg = encode_lsp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"capabilities": {}}})
            proc.stdin.write(msg)
            proc.stdin.flush()

            # Wait for response
            try:
                resp = response_queue.get(timeout=10)
                startup_time = time.time() - start
                results["startup"].append(startup_time * 1000)
            except queue.Empty:
                print("TIMEOUT on initialize")
                continue

            # Initialized
            msg = encode_lsp({"jsonrpc": "2.0", "method": "initialized", "params": {}})
            proc.stdin.write(msg)
            proc.stdin.flush()
            time.sleep(0.1)

            # didOpen
            start = time.time()
            msg = encode_lsp({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
                "textDocument": {"uri": uri, "languageId": "elm", "version": 1, "text": ELM_SOURCE}
            }})
            proc.stdin.write(msg)
            proc.stdin.flush()
            time.sleep(0.3)  # Give time to parse
            results["didOpen"].append((time.time() - start) * 1000)

            # documentSymbol
            start = time.time()
            msg = encode_lsp({"jsonrpc": "2.0", "id": 2, "method": "textDocument/documentSymbol", "params": {
                "textDocument": {"uri": uri}
            }})
            proc.stdin.write(msg)
            proc.stdin.flush()
            try:
                resp = response_queue.get(timeout=5)
                results["documentSymbol"].append((time.time() - start) * 1000)
            except queue.Empty:
                results["documentSymbol"].append(float('inf'))

            # hover (on 'update' function, line 52)
            start = time.time()
            msg = encode_lsp({"jsonrpc": "2.0", "id": 3, "method": "textDocument/hover", "params": {
                "textDocument": {"uri": uri},
                "position": {"line": 51, "character": 0}
            }})
            proc.stdin.write(msg)
            proc.stdin.flush()
            try:
                resp = response_queue.get(timeout=5)
                results["hover"].append((time.time() - start) * 1000)
            except queue.Empty:
                results["hover"].append(float('inf'))

            # completion (line 60, after 'model.')
            start = time.time()
            msg = encode_lsp({"jsonrpc": "2.0", "id": 4, "method": "textDocument/completion", "params": {
                "textDocument": {"uri": uri},
                "position": {"line": 59, "character": 20}
            }})
            proc.stdin.write(msg)
            proc.stdin.flush()
            try:
                resp = response_queue.get(timeout=10)
                results["completion"].append((time.time() - start) * 1000)
            except queue.Empty:
                results["completion"].append(float('inf'))

            # definition (on 'model' in update function)
            start = time.time()
            msg = encode_lsp({"jsonrpc": "2.0", "id": 5, "method": "textDocument/definition", "params": {
                "textDocument": {"uri": uri},
                "position": {"line": 53, "character": 10}
            }})
            proc.stdin.write(msg)
            proc.stdin.flush()
            try:
                resp = response_queue.get(timeout=5)
                results["definition"].append((time.time() - start) * 1000)
            except queue.Empty:
                results["definition"].append(float('inf'))

            # references (on 'Model' type)
            start = time.time()
            msg = encode_lsp({"jsonrpc": "2.0", "id": 6, "method": "textDocument/references", "params": {
                "textDocument": {"uri": uri},
                "position": {"line": 8, "character": 13},
                "context": {"includeDeclaration": True}
            }})
            proc.stdin.write(msg)
            proc.stdin.flush()
            try:
                resp = response_queue.get(timeout=5)
                results["references"].append((time.time() - start) * 1000)
            except queue.Empty:
                results["references"].append(float('inf'))

            print("OK")

        except Exception as e:
            print(f"ERROR: {e}")
        finally:
            stop_event.set()
            try:
                proc.terminate()
                proc.wait(timeout=1)
            except:
                proc.kill()
            reader.join(timeout=1)

    return results

def print_results(name, results):
    print(f"\n{'='*60}")
    print(f"  {name}")
    print(f"{'='*60}")

    for op, times in results.items():
        valid_times = [t for t in times if t != float('inf')]
        if valid_times:
            avg = sum(valid_times) / len(valid_times)
            min_t = min(valid_times)
            max_t = max(valid_times)
            print(f"  {op:20s}: avg={avg:8.2f}ms  min={min_t:8.2f}ms  max={max_t:8.2f}ms")
        else:
            print(f"  {op:20s}: TIMEOUT/ERROR")

def main():
    print("=" * 60)
    print("  Elm LSP Benchmark: Rust vs TypeScript")
    print("=" * 60)
    print(f"\nTest file: {len(ELM_SOURCE)} bytes, ~140 lines")
    print(f"Iterations: 5")

    uri = "file:///benchmark/Main.elm"

    # Check if servers exist
    if not os.path.exists(RUST_LSP):
        print(f"\nERROR: Rust LSP not found at {RUST_LSP}")
        print("Run: cargo build --release")
        return

    if not os.path.exists(TS_LSP):
        print(f"\nERROR: TypeScript LSP not found at {TS_LSP}")
        return

    # Benchmark Rust LSP
    print("\n" + "-" * 60)
    print("Benchmarking Rust LSP...")
    print("-" * 60)
    rust_results = benchmark_lsp("Rust", [RUST_LSP], uri)

    # Benchmark TypeScript LSP (with rootUri)
    print("\n" + "-" * 60)
    print("Benchmarking TypeScript LSP...")
    print("-" * 60)
    # Note: TS LSP needs rootUri to work properly
    ts_results = benchmark_lsp("TypeScript", ["node", TS_LSP, "--stdio"], uri)

    # Print results
    print_results("Rust Elm LSP", rust_results)
    print_results("TypeScript Elm LSP (@charlontank/elm-language-server)", ts_results)

    # Comparison
    print(f"\n{'='*60}")
    print("  Comparison (Rust vs TypeScript)")
    print(f"{'='*60}")

    for op in rust_results.keys():
        rust_valid = [t for t in rust_results[op] if t != float('inf')]
        ts_valid = [t for t in ts_results[op] if t != float('inf')]

        if rust_valid and ts_valid:
            rust_avg = sum(rust_valid) / len(rust_valid)
            ts_avg = sum(ts_valid) / len(ts_valid)
            if rust_avg > 0:
                speedup = ts_avg / rust_avg
                print(f"  {op:20s}: Rust is {speedup:.1f}x {'faster' if speedup > 1 else 'slower'}")
        elif rust_valid:
            print(f"  {op:20s}: TypeScript TIMEOUT, Rust OK")
        elif ts_valid:
            print(f"  {op:20s}: Rust TIMEOUT, TypeScript OK")
        else:
            print(f"  {op:20s}: Both TIMEOUT")

if __name__ == "__main__":
    main()
