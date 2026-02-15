use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};

// ─── Destructive Patterns ───────────────────────────────────────────

fn destructive_get_patterns() -> Vec<Regex> {
    vec![
        Regex::new(r"(?i)/logout").unwrap(),
        Regex::new(r"(?i)/signout").unwrap(),
        Regex::new(r"(?i)/sign-out").unwrap(),
        Regex::new(r"(?i)/unsubscribe").unwrap(),
        Regex::new(r"(?i)/delete").unwrap(),
        Regex::new(r"(?i)/remove").unwrap(),
        Regex::new(r"(?i)/destroy").unwrap(),
        Regex::new(r"(?i)/toggle").unwrap(),
        Regex::new(r"(?i)/activate").unwrap(),
        Regex::new(r"(?i)/deactivate").unwrap(),
        Regex::new(r"(?i)/api/.*/webhook").unwrap(),
    ]
}

fn destructive_post_patterns() -> Vec<Regex> {
    vec![
        Regex::new(r"(?i)/mutation").unwrap(),
        Regex::new(r"(?i)/charge").unwrap(),
        Regex::new(r"(?i)/delete").unwrap(),
        Regex::new(r"(?i)/send").unwrap(),
        Regex::new(r"(?i)/order").unwrap(),
        Regex::new(r"(?i)/payment").unwrap(),
    ]
}

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathRiskInput {
    method: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathRiskResult {
    blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn check_path_risk(input_json: String) -> napi::Result<String> {
    let input: PathRiskInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    let upper_method = input.method.to_uppercase();

    if upper_method == "GET" || upper_method == "HEAD" {
        for pattern in destructive_get_patterns() {
            if pattern.is_match(&input.path) {
                let result = PathRiskResult {
                    blocked: true,
                    reason: Some(format!(
                        "Destructive GET pattern detected: {} on path '{}'",
                        pattern.as_str(),
                        input.path
                    )),
                };
                return serde_json::to_string(&result)
                    .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
            }
        }
    }

    if upper_method == "POST" {
        for pattern in destructive_post_patterns() {
            if pattern.is_match(&input.path) {
                let result = PathRiskResult {
                    blocked: true,
                    reason: Some(format!(
                        "Destructive POST pattern detected: {} on path '{}'",
                        pattern.as_str(),
                        input.path
                    )),
                };
                return serde_json::to_string(&result)
                    .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
            }
        }
    }

    // PUT, PATCH, DELETE are inherently destructive
    if upper_method == "PUT" || upper_method == "PATCH" || upper_method == "DELETE" {
        let result = PathRiskResult {
            blocked: true,
            reason: Some(format!(
                "HTTP method '{}' is inherently destructive",
                upper_method
            )),
        };
        return serde_json::to_string(&result)
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
    }

    let result = PathRiskResult {
        blocked: false,
        reason: None,
    };
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)))
}
