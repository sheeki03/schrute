use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use url::Url;

// ─── Tracking Params to Strip ───────────────────────────────────────

const TRACKING_PARAMS: &[&str] = &[
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "msclkid", "twclid",
    "_ga", "_gl", "_hsenc", "_hsmi",
    "mc_cid", "mc_eid",
];

const EPHEMERAL_BODY_KEYS: &[&str] = &[
    "timestamp", "requestId", "request_id", "nonce",
    "_t", "_ts", "_timestamp", "_nonce",
    "correlationId", "correlation_id",
    "traceId", "trace_id", "spanId", "span_id",
];

// ─── Input/Output Types ─────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalizationInput {
    url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    content_type: Option<String>,
    method: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalizationOutput {
    method: String,
    canonical_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    canonical_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
}

// ─── URL Canonicalization ───────────────────────────────────────────

fn canonicalize_url(raw: &str) -> String {
    let mut parsed = match Url::parse(raw) {
        Ok(u) => u,
        Err(_) => return raw.to_string(),
    };

    // Lowercase host
    if let Some(host) = parsed.host_str() {
        let lower = host.to_lowercase();
        let _ = parsed.set_host(Some(&lower));
    }

    // Collect non-tracking params, sorted
    let params: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(name, _)| !TRACKING_PARAMS.contains(&name.as_ref()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    let mut sorted = params;
    sorted.sort_by(|a, b| a.0.cmp(&b.0));

    // Rebuild URL
    if sorted.is_empty() {
        parsed.set_query(None);
    } else {
        let qs: String = sorted
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");
        parsed.set_query(Some(&qs));
    }

    parsed.to_string()
}

// ─── JSON Body Canonicalization ─────────────────────────────────────

fn sort_and_clean(val: &serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::Object(map) => {
            let mut sorted = serde_json::Map::new();
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for key in keys {
                if EPHEMERAL_BODY_KEYS.contains(&key.as_str()) {
                    continue;
                }
                sorted.insert(key.clone(), sort_and_clean(&map[key]));
            }
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(sort_and_clean).collect())
        }
        other => other.clone(),
    }
}

fn canonicalize_json_body(body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(parsed) => {
            let cleaned = sort_and_clean(&parsed);
            serde_json::to_string(&cleaned).unwrap_or_else(|_| body.to_string())
        }
        Err(_) => body.to_string(),
    }
}

// ─── GraphQL Canonicalization ───────────────────────────────────────

fn canonicalize_graphql_query(query: &str) -> String {
    // Strip comments
    let re = regex::Regex::new(r"#[^\n]*").unwrap();
    let no_comments = re.replace_all(query, "");
    // Collapse whitespace
    let ws = regex::Regex::new(r"\s+").unwrap();
    ws.replace_all(&no_comments, " ").trim().to_string()
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn canonicalize_request(input_json: String) -> napi::Result<String> {
    let input: CanonicalizationInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    let canonical_url = canonicalize_url(&input.url);
    let ct = input.content_type.as_deref().unwrap_or("").to_lowercase();

    let canonical_body = if let Some(body) = &input.body {
        if ct.contains("application/json") || ct.contains("application/graphql+json") {
            // Check if GraphQL
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
                if parsed.is_object()
                    && (parsed.get("query").is_some() || parsed.get("operationName").is_some())
                {
                    // GraphQL request
                    let mut result = serde_json::Map::new();
                    if let Some(op) = parsed.get("operationName") {
                        result.insert("operationName".to_string(), op.clone());
                    }
                    if let Some(q) = parsed.get("query").and_then(|q| q.as_str()) {
                        result.insert(
                            "query".to_string(),
                            serde_json::Value::String(canonicalize_graphql_query(q)),
                        );
                    }
                    if let Some(vars) = parsed.get("variables") {
                        result.insert("variables".to_string(), sort_and_clean(vars));
                    }
                    Some(serde_json::to_string(&serde_json::Value::Object(result))
                        .unwrap_or_else(|_| body.clone()))
                } else {
                    Some(canonicalize_json_body(body))
                }
            } else {
                Some(canonicalize_json_body(body))
            }
        } else {
            Some(body.clone())
        }
    } else {
        None
    };

    let output = CanonicalizationOutput {
        method: input.method.to_uppercase(),
        canonical_url,
        canonical_body,
        content_type: input.content_type,
    };

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}
