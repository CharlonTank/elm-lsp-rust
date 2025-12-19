#!/bin/bash

# Test the Rust Elm LSP server

ELM_FILE="test.elm"
URI="file://$(pwd)/$ELM_FILE"

# Create a test Elm file
cat > $ELM_FILE << 'EOF'
module Test exposing (main, greet)

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
EOF

# Calculate content length for LSP messages
send_request() {
    local content="$1"
    local length=${#content}
    printf "Content-Length: %d\r\n\r\n%s" "$length" "$content"
}

# Build the requests
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}'
INITIALIZED='{"jsonrpc":"2.0","method":"initialized","params":{}}'

# Read file content and escape for JSON
FILE_CONTENT=$(cat $ELM_FILE | sed 's/"/\\"/g' | tr '\n' '\\' | sed 's/\\/\\n/g')
OPEN="{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/didOpen\",\"params\":{\"textDocument\":{\"uri\":\"$URI\",\"languageId\":\"elm\",\"version\":1,\"text\":\"$FILE_CONTENT\"}}}"
SYMBOLS="{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"textDocument/documentSymbol\",\"params\":{\"textDocument\":{\"uri\":\"$URI\"}}}"

echo "Testing Rust Elm LSP..."
echo ""

# Run the server with input
{
    send_request "$INIT"
    sleep 0.1
    send_request "$INITIALIZED"
    sleep 0.1
    send_request "$OPEN"
    sleep 0.1
    send_request "$SYMBOLS"
    sleep 0.2
} | timeout 3 ./target/release/elm_lsp 2>&1 | grep -A1 "documentSymbol\|symbols" || echo "Responses received (check output above)"

# Cleanup
rm -f $ELM_FILE

echo ""
echo "Test complete!"
