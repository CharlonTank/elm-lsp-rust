//! Disjoint Set (Union-Find) for type unification.
//!
//! This data structure maps type variables to their unified types,
//! with path compression for efficient lookups.

use crate::types::Type;
use std::collections::{HashMap, HashSet};

/// Disjoint set for type variable substitutions
#[derive(Debug, Clone, Default)]
pub struct DisjointSet {
    /// Map from type variable ID to its substituted type
    map: HashMap<u64, Type>,
}

impl DisjointSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a type variable's substitution
    pub fn set(&mut self, var_id: u64, ty: Type) {
        self.map.insert(var_id, ty);
    }

    /// Check if a type variable has a substitution
    pub fn contains(&self, var_id: u64) -> bool {
        self.map.contains_key(&var_id)
    }

    /// Get the canonical (fully resolved) type for a given type.
    /// Follows the substitution chain to find the root type.
    pub fn get(&self, ty: &Type) -> Type {
        match ty {
            Type::Var(var) => {
                let mut current_id = var.id;
                let mut visited = HashSet::new();
                visited.insert(current_id);

                // Follow the chain with O(1) cycle detection
                while let Some(next_type) = self.map.get(&current_id) {
                    match next_type {
                        Type::Var(next_var) => {
                            if !visited.insert(next_var.id) {
                                // Cycle detected (insert returns false if already present)
                                return ty.clone();
                            }
                            current_id = next_var.id;
                        }
                        other => {
                            // Found a concrete type
                            return other.clone();
                        }
                    }
                }

                // Return the final type variable in the chain
                if let Some(final_type) = self.map.get(&current_id) {
                    final_type.clone()
                } else if current_id == var.id {
                    ty.clone()
                } else {
                    // Return the type variable we ended up at
                    Type::Var(crate::types::TypeVar {
                        id: current_id,
                        name: format!("t{}", current_id),
                        rigid: false,
                        alias: None,
                    })
                }
            }
            // Non-variable types are returned as-is
            _ => ty.clone(),
        }
    }

    /// Apply substitutions recursively to a type
    pub fn apply(&self, ty: &Type) -> Type {
        match ty {
            Type::Var(var) => {
                let resolved = self.get(ty);
                if let Type::Var(resolved_var) = &resolved {
                    if resolved_var.id == var.id {
                        // Not substituted
                        return resolved;
                    }
                }
                // Recursively apply in case the substitution contains more variables
                self.apply(&resolved)
            }
            Type::Function(f) => Type::Function(crate::types::FunctionType {
                params: f.params.iter().map(|p| self.apply(p)).collect(),
                ret: Box::new(self.apply(&f.ret)),
                alias: f.alias.clone(),
            }),
            Type::Tuple(t) => Type::Tuple(crate::types::TupleType {
                types: t.types.iter().map(|t| self.apply(t)).collect(),
                alias: t.alias.clone(),
            }),
            Type::Union(u) => Type::Union(crate::types::UnionType {
                module: u.module.clone(),
                name: u.name.clone(),
                params: u.params.iter().map(|p| self.apply(p)).collect(),
                alias: u.alias.clone(),
            }),
            Type::Record(r) => {
                let fields = r
                    .fields
                    .iter()
                    .map(|(k, v)| (k.clone(), self.apply(v)))
                    .collect();
                let base_type = r.base_type.as_ref().map(|b| Box::new(self.apply(b)));
                Type::Record(crate::types::RecordType {
                    fields,
                    base_type,
                    alias: r.alias.clone(),
                    field_references: r.field_references.clone(),
                })
            }
            Type::MutableRecord(mr) => {
                let fields = mr
                    .fields
                    .iter()
                    .map(|(k, v)| (k.clone(), self.apply(v)))
                    .collect();
                let base_type = mr.base_type.as_ref().map(|b| Box::new(self.apply(b)));
                Type::MutableRecord(crate::types::MutableRecordType {
                    fields,
                    base_type,
                    field_references: mr.field_references.clone(),
                })
            }
            Type::Unit(_) | Type::InProgressBinding | Type::Unknown => ty.clone(),
        }
    }

    /// Get the internal map (for debugging/inspection)
    pub fn to_map(&self) -> &HashMap<u64, Type> {
        &self.map
    }

    /// Clear all substitutions
    pub fn clear(&mut self) {
        self.map.clear();
    }

    /// Number of substitutions
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{reset_type_var_counter, Type};

    #[test]
    fn test_simple_substitution() {
        reset_type_var_counter();
        let mut ds = DisjointSet::new();

        let t1 = Type::fresh_var();
        let var_id = t1.var_id().unwrap();

        ds.set(var_id, Type::int());

        let result = ds.get(&t1);
        assert!(matches!(result, Type::Union(u) if u.name == "Int"));
    }

    #[test]
    fn test_chain_substitution() {
        reset_type_var_counter();
        let mut ds = DisjointSet::new();

        let t1 = Type::fresh_var();
        let t2 = Type::fresh_var();
        let t1_id = t1.var_id().unwrap();
        let t2_id = t2.var_id().unwrap();

        // t1 -> t2 -> Int
        ds.set(t1_id, t2.clone());
        ds.set(t2_id, Type::int());

        let result = ds.get(&t1);
        assert!(matches!(result, Type::Union(u) if u.name == "Int"));
    }

    #[test]
    fn test_apply_to_function() {
        reset_type_var_counter();
        let mut ds = DisjointSet::new();

        let t1 = Type::fresh_var();
        let var_id = t1.var_id().unwrap();
        ds.set(var_id, Type::int());

        let func = Type::function(vec![t1], Type::string());
        let result = ds.apply(&func);

        if let Type::Function(f) = result {
            assert!(matches!(&f.params[0], Type::Union(u) if u.name == "Int"));
            assert!(matches!(&*f.ret, Type::Union(u) if u.name == "String"));
        } else {
            panic!("Expected function type");
        }
    }

    #[test]
    fn test_unsubstituted_var() {
        reset_type_var_counter();
        let ds = DisjointSet::new();

        let t1 = Type::fresh_var();
        let var_id = t1.var_id().unwrap();

        let result = ds.get(&t1);
        assert!(matches!(result, Type::Var(v) if v.id == var_id));
    }
}
