// Placeholder — real implementation in T3.

use std::collections::HashMap;

pub fn get_user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
}

pub fn load_shell_env(_shell: &str) -> Option<HashMap<String, String>> {
    None
}

pub fn merge_shell_env(
    shell_env: Option<HashMap<String, String>>,
    overrides: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let mut merged = shell_env.unwrap_or_default();
    for (k, v) in overrides {
        merged.insert(k, v);
    }
    merged.into_iter().collect()
}
