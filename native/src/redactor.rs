use hmac::{Hmac, Mac};
use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

// ─── PII Patterns ───────────────────────────────────────────────────

struct PiiPattern {
    name: &'static str,
    regex: Regex,
}

fn build_pii_patterns() -> Vec<PiiPattern> {
    vec![
        PiiPattern {
            name: "email",
            regex: Regex::new(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}").unwrap(),
        },
        PiiPattern {
            name: "phone",
            regex: Regex::new(r"(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}").unwrap(),
        },
        PiiPattern {
            name: "uuid",
            regex: Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap(),
        },
        PiiPattern {
            name: "mongodb_objectid",
            regex: Regex::new(r"(?i)\b[0-9a-f]{24}\b").unwrap(),
        },
        PiiPattern {
            name: "jwt",
            regex: Regex::new(r"eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+").unwrap(),
        },
        PiiPattern {
            name: "bearer_token",
            regex: Regex::new(r"(?i)Bearer\s+[A-Za-z0-9_\-.~+/]+=*").unwrap(),
        },
        PiiPattern {
            name: "aws_key",
            regex: Regex::new(r"(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}").unwrap(),
        },
        PiiPattern {
            name: "api_key",
            regex: Regex::new(r#"(?i)(?:api[_\-]?key|apikey|api_secret|access_token|secret_key)\s*[:=]\s*['"]?([A-Za-z0-9_\-.]{16,})['"]?"#).unwrap(),
        },
        PiiPattern {
            name: "credit_card",
            regex: Regex::new(r"\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b").unwrap(),
        },
        PiiPattern {
            name: "ssn",
            regex: Regex::new(r"\b\d{3}-\d{2}-\d{4}\b").unwrap(),
        },
    ]
}

fn contains_pii(value: &str, patterns: &[PiiPattern]) -> Option<&'static str> {
    for p in patterns {
        if p.regex.is_match(value) {
            return Some(p.name);
        }
    }
    None
}

fn is_safe_value(value: &str) -> bool {
    if Regex::new(r"^\d{1,5}$").unwrap().is_match(value) {
        return true;
    }
    if Regex::new(r"(?i)^(true|false|null|undefined)$")
        .unwrap()
        .is_match(value)
    {
        return true;
    }
    if Regex::new(r"(?i)^[a-z_]{1,30}$").unwrap().is_match(value) {
        return true;
    }
    false
}

fn hmac_redact(value: &str, salt: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(salt).expect("HMAC key error");
    mac.update(value.as_bytes());
    let result = mac.finalize();
    let hex = hex::encode(result.into_bytes());
    format!("[REDACTED:{}]", &hex[..12])
}

fn mask_value(value: &str) -> String {
    if value.len() <= 4 {
        return "***".to_string();
    }
    format!("{}***{}", &value[..2], &value[value.len() - 2..])
}

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedactInput {
    value: serde_json::Value,
    salt: String,
    #[serde(default = "default_mode")]
    mode: String,
}

fn default_mode() -> String {
    "agent-safe".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RedactOutput {
    redacted: serde_json::Value,
}

// ─── Sensitive Headers ──────────────────────────────────────────────

const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
    "proxy-authorization",
];

// ─── Recursive Redaction ────────────────────────────────────────────

fn redact_value(
    val: &serde_json::Value,
    salt: &[u8],
    mode: &str,
    patterns: &[PiiPattern],
) -> serde_json::Value {
    match val {
        serde_json::Value::String(s) => {
            let redacted = redact_string(s, salt, patterns);
            if mode == "developer-debug" {
                if let Some(pii_type) = contains_pii(s, patterns) {
                    return serde_json::Value::String(format!("{} [was:{}]", redacted, pii_type));
                }
            }
            serde_json::Value::String(redacted)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(|v| redact_value(v, salt, mode, patterns)).collect())
        }
        serde_json::Value::Object(map) => {
            let mut result = serde_json::Map::new();
            for (k, v) in map {
                result.insert(k.clone(), redact_value(v, salt, mode, patterns));
            }
            serde_json::Value::Object(result)
        }
        other => other.clone(),
    }
}

fn redact_string(value: &str, salt: &[u8], patterns: &[PiiPattern]) -> String {
    if is_safe_value(value) {
        return value.to_string();
    }

    if contains_pii(value, patterns).is_some() {
        return hmac_redact(value, salt);
    }

    // Sensitive but non-PII: mask if it looks like a token/key
    if value.len() > 20 {
        let token_re = Regex::new(r"^[A-Za-z0-9_\-./+=]+$").unwrap();
        if token_re.is_match(value) {
            return mask_value(value);
        }
    }

    value.to_string()
}

// ─── hex module (inline) ────────────────────────────────────────────

mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{:02x}", b)).collect()
    }
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn redact(input_json: String) -> napi::Result<String> {
    let input: RedactInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    let patterns = build_pii_patterns();
    let salt = input.salt.as_bytes();
    let redacted = redact_value(&input.value, salt, &input.mode, &patterns);

    let output = RedactOutput { redacted };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn redact_headers(input_json: String) -> napi::Result<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    let headers = input
        .get("headers")
        .and_then(|h| h.as_object())
        .ok_or_else(|| napi::Error::from_reason("Missing 'headers' object"))?;
    let salt_str = input
        .get("salt")
        .and_then(|s| s.as_str())
        .unwrap_or("default-salt");
    let salt = salt_str.as_bytes();
    let patterns = build_pii_patterns();

    let mut result = serde_json::Map::new();
    for (key, value) in headers {
        if let Some(val_str) = value.as_str() {
            let lower_key = key.to_lowercase();
            let redacted = if SENSITIVE_HEADERS.contains(&lower_key.as_str()) {
                hmac_redact(val_str, salt)
            } else {
                redact_string(val_str, salt, &patterns)
            };
            result.insert(key.clone(), serde_json::Value::String(redacted));
        }
    }

    serde_json::to_string(&serde_json::Value::Object(result))
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}
