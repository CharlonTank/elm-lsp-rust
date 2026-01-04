use tower_lsp::lsp_types::*;

#[derive(Debug, Clone)]
pub struct VariantInfo {
    pub name: String,
    pub range: Range,
    pub full_range: Range,
}

#[derive(Debug, Clone)]
pub struct ElmSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub range: Range,
    pub definition_range: Option<Range>,
    pub type_annotation_range: Option<Range>,
    pub signature: Option<String>,
    pub documentation: Option<String>,
    pub references: Vec<Range>,
    pub variants: Vec<VariantInfo>,
}

impl ElmSymbol {
    pub fn new(name: String, kind: SymbolKind, range: Range) -> Self {
        Self {
            name,
            kind,
            range,
            definition_range: None,
            type_annotation_range: None,
            signature: None,
            documentation: None,
            references: Vec::new(),
            variants: Vec::new(),
        }
    }

    pub fn contains_position(&self, position: Position) -> bool {
        if position.line < self.range.start.line || position.line > self.range.end.line {
            return false;
        }
        if position.line == self.range.start.line && position.character < self.range.start.character
        {
            return false;
        }
        if position.line == self.range.end.line && position.character > self.range.end.character {
            return false;
        }
        true
    }

    pub fn is_position_on_name(&self, position: Position) -> bool {
        let name_range = self.definition_range.unwrap_or(self.range);
        position.line >= name_range.start.line
            && position.line <= name_range.end.line
            && (position.line != name_range.start.line
                || position.character >= name_range.start.character)
            && (position.line != name_range.end.line
                || position.character <= name_range.end.character)
    }
}

#[derive(Debug, Clone)]
pub struct Document {
    pub uri: Url,
    pub text: String,
    pub version: i32,
    pub symbols: Vec<ElmSymbol>,
}

impl Document {
    pub fn new(uri: Url, text: String, version: i32) -> Self {
        Self {
            uri,
            text,
            version,
            symbols: Vec::new(),
        }
    }

    pub fn get_symbol_at_position(&self, position: Position) -> Option<&ElmSymbol> {
        self.symbols
            .iter()
            .find(|s| s.is_position_on_name(position))
    }

    pub fn get_line(&self, line: u32) -> Option<&str> {
        self.text.lines().nth(line as usize)
    }

    pub fn offset_to_position(&self, offset: usize) -> Position {
        let mut line = 0u32;
        let mut col = 0u32;
        for (i, c) in self.text.char_indices() {
            if i == offset {
                break;
            }
            if c == '\n' {
                line += 1;
                col = 0;
            } else {
                col += 1;
            }
        }
        Position::new(line, col)
    }
}
