#!/bin/bash
# Install git hooks for elm-lsp-rust development

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$PROJECT_ROOT/.git/hooks"

echo "Installing git hooks..."

# Create pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash
# elm-lsp-rust pre-commit hook
# Runs all tests and updates coverage before allowing commit

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Running elm-lsp-rust test suite..."
echo ""

# Run the master test suite
if ! node "$PROJECT_ROOT/tests/run_all_tests.mjs"; then
    echo ""
    echo "❌ Tests failed! Commit aborted."
    echo ""
    echo "Fix the failing tests before committing."
    exit 1
fi

# Stage the updated COVERAGE.md if it was modified
if git diff --name-only "$PROJECT_ROOT/tests/COVERAGE.md" | grep -q COVERAGE.md; then
    git add "$PROJECT_ROOT/tests/COVERAGE.md"
    echo ""
    echo "📝 Updated and staged tests/COVERAGE.md"
fi

echo ""
echo "✅ All tests passed! Proceeding with commit."
EOF

chmod +x "$HOOKS_DIR/pre-commit"

echo "✅ Pre-commit hook installed!"
echo ""
echo "The hook will:"
echo "  - Run all tests before each commit"
echo "  - Update tests/COVERAGE.md with test results"
echo "  - Block commits if tests fail"
