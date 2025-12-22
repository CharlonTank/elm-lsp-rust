//! Type definitions for Elm type inference.
//!
//! This module implements the core type representations used in Hindley-Milner
//! type inference for Elm. Based on elm-language-server's typeInference.ts.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

/// Global counter for generating unique type variable IDs
static TYPE_VAR_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Generate a fresh unique type variable ID
pub fn fresh_type_var_id() -> u64 {
    TYPE_VAR_COUNTER.fetch_add(1, Ordering::SeqCst)
}

/// Reset the type variable counter (useful for testing)
pub fn reset_type_var_counter() {
    TYPE_VAR_COUNTER.store(0, Ordering::SeqCst);
}

/// Type alias information - tracks which type alias a type came from
#[derive(Debug, Clone, PartialEq)]
pub struct Alias {
    pub module: String,
    pub name: String,
    pub parameters: Vec<Type>,
}

/// Core type representation for Elm types
#[derive(Debug, Clone, PartialEq)]
pub enum Type {
    /// Type variable (e.g., `a`, `comparable`)
    Var(TypeVar),
    /// Function type (e.g., `a -> b -> c`)
    Function(FunctionType),
    /// Tuple type (e.g., `(a, b)`)
    Tuple(TupleType),
    /// Union type / Custom type (e.g., `Maybe a`, `Result error value`)
    Union(UnionType),
    /// Record type (e.g., `{ name : String, age : Int }`)
    Record(RecordType),
    /// Mutable record (used during inference for record updates)
    MutableRecord(MutableRecordType),
    /// Unit type `()`
    Unit(Option<Alias>),
    /// Type currently being inferred (prevents infinite recursion)
    InProgressBinding,
    /// Unknown/error type
    Unknown,
}

/// Type variable
#[derive(Debug, Clone, PartialEq)]
pub struct TypeVar {
    /// Unique identifier for this type variable
    pub id: u64,
    /// Optional name (e.g., "a", "comparable", "number")
    pub name: String,
    /// If true, this type variable cannot be unified with other types
    /// (comes from a type annotation)
    pub rigid: bool,
    /// Optional alias this type came from
    pub alias: Option<Alias>,
}

/// Function type: params -> return
#[derive(Debug, Clone, PartialEq)]
pub struct FunctionType {
    pub params: Vec<Type>,
    pub ret: Box<Type>,
    pub alias: Option<Alias>,
}

/// Tuple type
#[derive(Debug, Clone, PartialEq)]
pub struct TupleType {
    pub types: Vec<Type>,
    pub alias: Option<Alias>,
}

/// Union type (custom type)
#[derive(Debug, Clone, PartialEq)]
pub struct UnionType {
    pub module: String,
    pub name: String,
    pub params: Vec<Type>,
    pub alias: Option<Alias>,
}

/// Record type with field references for tracking
#[derive(Debug, Clone, PartialEq)]
pub struct RecordType {
    pub fields: HashMap<String, Type>,
    /// Base type for extensible records: `{ a | name : String }`
    pub base_type: Option<Box<Type>>,
    pub alias: Option<Alias>,
    /// Maps field names to AST node IDs where they're referenced
    pub field_references: RecordFieldReferenceTable,
}

/// Mutable record type (used during inference)
#[derive(Debug, Clone, PartialEq)]
pub struct MutableRecordType {
    pub fields: HashMap<String, Type>,
    pub base_type: Option<Box<Type>>,
    pub field_references: RecordFieldReferenceTable,
}

/// Tracks references to record fields during type inference
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecordFieldReferenceTable {
    /// Map from field name to list of AST node IDs that reference it
    refs_by_field: HashMap<String, Vec<FieldReference>>,
    frozen: bool,
}

/// A reference to a record field in the AST
#[derive(Debug, Clone, PartialEq)]
pub struct FieldReference {
    pub node_id: usize,
    pub uri: String,
}

impl RecordFieldReferenceTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, field: &str) -> Vec<&FieldReference> {
        self.refs_by_field.get(field).map_or(Vec::new(), |refs| refs.iter().collect())
    }

    pub fn add(&mut self, field: &str, reference: FieldReference) {
        if self.frozen {
            return;
        }
        self.refs_by_field
            .entry(field.to_string())
            .or_default()
            .push(reference);
    }

    pub fn add_all(&mut self, other: &RecordFieldReferenceTable) {
        if self.frozen {
            return;
        }
        for (field, refs) in &other.refs_by_field {
            let entry = self.refs_by_field.entry(field.clone()).or_default();
            entry.extend(refs.iter().cloned());
        }
    }

    pub fn merge(&self, other: &RecordFieldReferenceTable) -> RecordFieldReferenceTable {
        let mut result = self.clone();
        result.add_all(other);
        result
    }

    pub fn is_empty(&self) -> bool {
        self.refs_by_field.is_empty()
    }

    pub fn freeze(&mut self) {
        self.frozen = true;
    }

    pub fn is_frozen(&self) -> bool {
        self.frozen
    }
}

// Type constructors for convenience

impl Type {
    pub fn var(name: impl Into<String>) -> Self {
        Type::Var(TypeVar {
            id: fresh_type_var_id(),
            name: name.into(),
            rigid: false,
            alias: None,
        })
    }

    pub fn rigid_var(name: impl Into<String>) -> Self {
        Type::Var(TypeVar {
            id: fresh_type_var_id(),
            name: name.into(),
            rigid: true,
            alias: None,
        })
    }

    pub fn fresh_var() -> Self {
        let id = fresh_type_var_id();
        Type::Var(TypeVar {
            id,
            name: format!("t{}", id),
            rigid: false,
            alias: None,
        })
    }

    pub fn function(params: Vec<Type>, ret: Type) -> Self {
        Type::Function(FunctionType {
            params,
            ret: Box::new(ret),
            alias: None,
        })
    }

    pub fn tuple(types: Vec<Type>) -> Self {
        if types.is_empty() {
            Type::Unit(None)
        } else {
            Type::Tuple(TupleType { types, alias: None })
        }
    }

    pub fn union(module: impl Into<String>, name: impl Into<String>, params: Vec<Type>) -> Self {
        Type::Union(UnionType {
            module: module.into(),
            name: name.into(),
            params,
            alias: None,
        })
    }

    pub fn record(fields: HashMap<String, Type>) -> Self {
        Type::Record(RecordType {
            fields,
            base_type: None,
            alias: None,
            field_references: RecordFieldReferenceTable::new(),
        })
    }

    pub fn extensible_record(base: Type, fields: HashMap<String, Type>) -> Self {
        Type::Record(RecordType {
            fields,
            base_type: Some(Box::new(base)),
            alias: None,
            field_references: RecordFieldReferenceTable::new(),
        })
    }

    pub fn unit() -> Self {
        Type::Unit(None)
    }

    pub fn unknown() -> Self {
        Type::Unknown
    }

    // Common built-in types

    pub fn int() -> Self {
        Type::union("Basics", "Int", vec![])
    }

    pub fn float() -> Self {
        Type::union("Basics", "Float", vec![])
    }

    pub fn bool() -> Self {
        Type::union("Basics", "Bool", vec![])
    }

    pub fn string() -> Self {
        Type::union("String", "String", vec![])
    }

    pub fn char() -> Self {
        Type::union("Char", "Char", vec![])
    }

    pub fn list(element_type: Type) -> Self {
        Type::union("List", "List", vec![element_type])
    }

    pub fn maybe(inner_type: Type) -> Self {
        Type::union("Maybe", "Maybe", vec![inner_type])
    }

    /// Check if this type is a type variable
    pub fn is_var(&self) -> bool {
        matches!(self, Type::Var(_))
    }

    /// Check if this type is a function type
    pub fn is_function(&self) -> bool {
        matches!(self, Type::Function(_))
    }

    /// Check if this type is a record type
    pub fn is_record(&self) -> bool {
        matches!(self, Type::Record(_))
    }

    /// Get the alias if this type has one
    pub fn alias(&self) -> Option<&Alias> {
        match self {
            Type::Var(v) => v.alias.as_ref(),
            Type::Function(f) => f.alias.as_ref(),
            Type::Tuple(t) => t.alias.as_ref(),
            Type::Union(u) => u.alias.as_ref(),
            Type::Record(r) => r.alias.as_ref(),
            Type::MutableRecord(_) => None,
            Type::Unit(a) => a.as_ref(),
            Type::InProgressBinding => None,
            Type::Unknown => None,
        }
    }

    /// Set the alias for this type
    pub fn with_alias(mut self, alias: Alias) -> Self {
        match &mut self {
            Type::Var(v) => v.alias = Some(alias),
            Type::Function(f) => f.alias = Some(alias),
            Type::Tuple(t) => t.alias = Some(alias),
            Type::Union(u) => u.alias = Some(alias),
            Type::Record(r) => r.alias = Some(alias),
            Type::MutableRecord(_) => {}
            Type::Unit(a) => *a = Some(alias),
            Type::InProgressBinding => {}
            Type::Unknown => {}
        }
        self
    }

    /// Get the type variable ID if this is a Var
    pub fn var_id(&self) -> Option<u64> {
        match self {
            Type::Var(v) => Some(v.id),
            _ => None,
        }
    }

    /// Convert a MutableRecord to a Record
    pub fn freeze_record(self) -> Self {
        match self {
            Type::MutableRecord(mr) => Type::Record(RecordType {
                fields: mr.fields,
                base_type: mr.base_type,
                alias: None,
                field_references: mr.field_references,
            }),
            other => other,
        }
    }
}

impl MutableRecordType {
    pub fn new(fields: HashMap<String, Type>, base_type: Option<Box<Type>>) -> Self {
        Self {
            fields,
            base_type,
            field_references: RecordFieldReferenceTable::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_type_var_ids_are_unique() {
        reset_type_var_counter();
        let t1 = Type::fresh_var();
        let t2 = Type::fresh_var();

        match (&t1, &t2) {
            (Type::Var(v1), Type::Var(v2)) => {
                assert_ne!(v1.id, v2.id);
            }
            _ => panic!("Expected Var types"),
        }
    }

    #[test]
    fn test_record_field_references() {
        let mut table = RecordFieldReferenceTable::new();
        table.add("name", FieldReference { node_id: 1, uri: "test.elm".to_string() });
        table.add("name", FieldReference { node_id: 2, uri: "test.elm".to_string() });

        let refs = table.get("name");
        assert_eq!(refs.len(), 2);

        let empty = table.get("nonexistent");
        assert!(empty.is_empty());
    }

    #[test]
    fn test_frozen_table_rejects_additions() {
        let mut table = RecordFieldReferenceTable::new();
        table.add("name", FieldReference { node_id: 1, uri: "test.elm".to_string() });
        table.freeze();
        table.add("name", FieldReference { node_id: 2, uri: "test.elm".to_string() });

        let refs = table.get("name");
        assert_eq!(refs.len(), 1); // Second add was ignored
    }
}
