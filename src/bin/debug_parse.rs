use tree_sitter::{Language, Parser};

fn elm_language() -> Language {
    tree_sitter_elm::LANGUAGE.into()
}

fn main() {
    let source = r#"module Test exposing (main, greet)

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
"#;

    let mut parser = Parser::new();
    parser.set_language(&elm_language()).expect("Failed to load Elm grammar");

    match parser.parse(source, None) {
        Some(tree) => {
            println!("Parse successful!");
            println!("\nTree structure:");
            print_tree(&tree.root_node(), source, 0);
        }
        None => {
            println!("Parse failed!");
        }
    }
}

fn print_tree(node: &tree_sitter::Node, source: &str, indent: usize) {
    let kind = node.kind();
    let range = format!("[{},{}]-[{},{}]",
        node.start_position().row,
        node.start_position().column,
        node.end_position().row,
        node.end_position().column
    );

    // Print node info
    let prefix = "  ".repeat(indent);
    if node.child_count() == 0 {
        // Leaf node - show the text
        let text = &source[node.byte_range()];
        let text_preview = if text.len() > 30 { &text[..30] } else { text };
        println!("{}{} {} \"{}\"", prefix, kind, range, text_preview.replace('\n', "\\n"));
    } else {
        println!("{}{} {}", prefix, kind, range);
    }

    // Recurse to children
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        print_tree(&child, source, indent + 1);
    }
}
