use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestSample {
    headers: HashMap<String, String>,
    query_params: HashMap<String, String>,
    body_fields: HashMap<String, serde_json::Value>,
    #[serde(default)]
    graphql_variables: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FieldVolatility {
    field_path: String,
    field_location: String,
    entropy: f64,
    change_rate: f64,
    looks_like_nonce: bool,
    looks_like_token: bool,
    is_static: bool,
}

struct FieldCollection {
    location: String,
    values: Vec<String>,
}

// ─── Shannon Entropy ────────────────────────────────────────────────

fn shannon_entropy(values: &[String]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    let all_chars: String = values.join("");
    if all_chars.is_empty() {
        return 0.0;
    }

    let mut freq: HashMap<char, usize> = HashMap::new();
    for ch in all_chars.chars() {
        *freq.entry(ch).or_insert(0) += 1;
    }

    let total = all_chars.len() as f64;
    let mut entropy = 0.0;
    for count in freq.values() {
        let p = *count as f64 / total;
        if p > 0.0 {
            entropy -= p * p.log2();
        }
    }

    entropy
}

// ─── Change Rate ────────────────────────────────────────────────────

fn compute_change_rate(values: &[String]) -> f64 {
    if values.len() <= 1 {
        return 0.0;
    }

    let mut changes = 0;
    for i in 1..values.len() {
        if values[i] != values[i - 1] {
            changes += 1;
        }
    }

    changes as f64 / (values.len() - 1) as f64
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn score_volatility(samples_json: String) -> napi::Result<String> {
    let samples: Vec<RequestSample> = serde_json::from_str(&samples_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse samples: {}", e)))?;

    if samples.is_empty() {
        return serde_json::to_string(&Vec::<FieldVolatility>::new())
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
    }

    let mut field_collections: HashMap<String, FieldCollection> = HashMap::new();

    for sample in &samples {
        // Headers
        for (key, value) in &sample.headers {
            let field_key = format!("header:{}", key.to_lowercase());
            let entry = field_collections.entry(field_key).or_insert(FieldCollection {
                location: "header".to_string(),
                values: Vec::new(),
            });
            entry.values.push(value.clone());
        }

        // Query params
        for (key, value) in &sample.query_params {
            let field_key = format!("query:{}", key);
            let entry = field_collections.entry(field_key).or_insert(FieldCollection {
                location: "query".to_string(),
                values: Vec::new(),
            });
            entry.values.push(value.clone());
        }

        // Body fields
        for (key, value) in &sample.body_fields {
            let field_key = format!("body:{}", key);
            let entry = field_collections.entry(field_key).or_insert(FieldCollection {
                location: "body".to_string(),
                values: Vec::new(),
            });
            entry.values.push(value.to_string());
        }

        // GraphQL variables
        if let Some(vars) = &sample.graphql_variables {
            for (key, value) in vars {
                let field_key = format!("graphql_variable:{}", key);
                let entry = field_collections.entry(field_key).or_insert(FieldCollection {
                    location: "graphql_variable".to_string(),
                    values: Vec::new(),
                });
                entry.values.push(value.to_string());
            }
        }
    }

    let mut results: Vec<FieldVolatility> = Vec::new();

    for (field_key, collection) in &field_collections {
        let field_path = field_key.splitn(2, ':').nth(1).unwrap_or("").to_string();
        let entropy = shannon_entropy(&collection.values);
        let change_rate = compute_change_rate(&collection.values);
        let is_static = change_rate == 0.0;
        let looks_like_nonce = entropy > 3.0 && change_rate >= 0.9;
        let looks_like_token = !looks_like_nonce && change_rate > 0.0 && change_rate < 0.9 && entropy > 2.0;

        results.push(FieldVolatility {
            field_path,
            field_location: collection.location.clone(),
            entropy,
            change_rate,
            looks_like_nonce,
            looks_like_token,
            is_static,
        });
    }

    serde_json::to_string(&results)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize results: {}", e)))
}
