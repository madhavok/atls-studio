pub use crate::chat_db_commands::*;
pub use crate::hash_commands::*;

#[cfg(test)]
mod tests {
    #[test]
    fn hash_command_types_roundtrip_through_commands_barrel() {
        let r = crate::commands::RegisterHashResult {
            short_hash: "ab".into(),
            current_revision_for_source: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["short_hash"], "ab");
    }
}
