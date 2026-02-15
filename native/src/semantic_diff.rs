use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticCheckInput {
    response: ResponseInput,
    skill: SkillInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResponseInput {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillInput {
    id: String,
    validation: ValidationInput,
    #[serde(default)]
    output_schema: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidationInput {
    semantic_checks: Vec<String>,
    custom_invariants: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticCheckResult {
    pass: bool,
    details: Vec<String>,
}

// ─── Schema Validation ──────────────────────────────────────────────

fn validate_structure(data: &serde_json::Value, schema: &serde_json::Value) -> bool {
    let schema_type = schema.get("type").and_then(|t| t.as_str());

    match schema_type {
        Some("object") => {
            if !data.is_object() {
                return false;
            }
            let obj = data.as_object().unwrap();

            if let Some(required) = schema.get("required").and_then(|r| r.as_array()) {
                for req_field in required {
                    if let Some(field_name) = req_field.as_str() {
                        if !obj.contains_key(field_name) {
                            return false;
                        }
                    }
                }
            }

            if let Some(properties) = schema.get("properties").and_then(|p| p.as_object()) {
                for (key, prop_schema) in properties {
                    if let Some(val) = obj.get(key) {
                        if !validate_structure(val, prop_schema) {
                            return false;
                        }
                    }
                }
            }

            true
        }
        Some("array") => {
            if !data.is_array() {
                return false;
            }
            if let Some(items_schema) = schema.get("items") {
                for item in data.as_array().unwrap() {
                    if !validate_structure(item, items_schema) {
                        return false;
                    }
                }
            }
            true
        }
        Some("string") => data.is_string(),
        Some("number") | Some("integer") => data.is_number(),
        Some("boolean") => data.is_boolean(),
        Some("null") => data.is_null(),
        _ => true,
    }
}

// ─── Error Signatures ───────────────────────────────────────────────

fn check_error_signatures(body: &str) -> Vec<String> {
    let mut found = Vec::new();

    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(obj) = parsed.as_object() {
            if obj.contains_key("error") {
                found.push("error_field".to_string());
            }
            if obj.contains_key("errors") {
                found.push("errors_field".to_string());
            }
        }
    }

    if Regex::new(r"(?i)session\s+expired")
        .unwrap()
        .is_match(body)
    {
        found.push("session_expired".to_string());
    }
    if Regex::new(r"(?i)please\s+refresh")
        .unwrap()
        .is_match(body)
    {
        found.push("please_refresh".to_string());
    }

    found
}

// ─── Custom Invariants ──────────────────────────────────────────────

fn evaluate_invariant(
    invariant: &str,
    parsed: &serde_json::Value,
    raw_body: &str,
) -> (bool, String) {
    // must_include_field:fieldName
    if let Some(field_name) = invariant.strip_prefix("must_include_field:") {
        let field_name = field_name.trim();
        if let Some(obj) = parsed.as_object() {
            if obj.contains_key(field_name) {
                return (true, String::new());
            }
        }
        return (false, format!("field '{}' not found", field_name));
    }

    // must_not_contain:marker
    if let Some(marker) = invariant.strip_prefix("must_not_contain:") {
        if raw_body.contains(marker) {
            return (false, format!("marker '{}' found in response", marker));
        }
        return (true, String::new());
    }

    // field_non_empty:fieldName
    if let Some(field_name) = invariant.strip_prefix("field_non_empty:") {
        let field_name = field_name.trim();
        if let Some(obj) = parsed.as_object() {
            if let Some(value) = obj.get(field_name) {
                match value {
                    serde_json::Value::Null => {}
                    serde_json::Value::String(s) if s.is_empty() => {}
                    serde_json::Value::Array(a) if a.is_empty() => {}
                    _ => return (true, String::new()),
                }
            }
        }
        return (
            false,
            format!("field '{}' is empty or missing", field_name),
        );
    }

    // Unknown invariant
    (true, "unknown invariant format (skipped)".to_string())
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn check_semantic(input_json: String) -> napi::Result<String> {
    let input: SemanticCheckInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    let mut details = Vec::new();
    let mut pass = true;

    let parsed: serde_json::Value = serde_json::from_str(&input.response.body)
        .unwrap_or(serde_json::Value::String(input.response.body.clone()));

    for check in &input.skill.validation.semantic_checks {
        match check.as_str() {
            "schema_match" => {
                let schema_ok = if let Some(schema) = &input.skill.output_schema {
                    if schema.as_object().map_or(true, |o| o.is_empty()) {
                        true
                    } else {
                        validate_structure(&parsed, schema)
                    }
                } else {
                    true
                };
                if !schema_ok {
                    pass = false;
                    details.push("schema_match: response does not match stored JSON Schema".to_string());
                } else {
                    details.push("schema_match: OK".to_string());
                }
            }
            "no_error_signatures" => {
                let error_sigs = check_error_signatures(&input.response.body);
                if !error_sigs.is_empty() {
                    pass = false;
                    details.push(format!(
                        "no_error_signatures: found [{}]",
                        error_sigs.join(", ")
                    ));
                } else {
                    details.push("no_error_signatures: OK".to_string());
                }
            }
            other => {
                details.push(format!("{}: skipped (unknown)", other));
            }
        }
    }

    for invariant in &input.skill.validation.custom_invariants {
        let (passed, reason) = evaluate_invariant(invariant, &parsed, &input.response.body);
        if !passed {
            pass = false;
        }
        details.push(format!(
            "{}: {}",
            invariant,
            if passed { "OK".to_string() } else { reason }
        ));
    }

    let result = SemanticCheckResult { pass, details };
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize result: {}", e)))
}
