use hmac::{Hmac, Mac};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

mod hex_util {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes
            .as_ref()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect()
    }
}

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComputeHashInput {
    entry_json: String,
    previous_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComputeHashOutput {
    entry_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignInput {
    entry_hash: String,
    hmac_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignOutput {
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyChainInput {
    entries_json: Vec<String>,
    hmac_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyChainOutput {
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    broken_at: Option<usize>,
    total_entries: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn compute_entry_hash(input_json: String) -> napi::Result<String> {
    let input: ComputeHashInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    // Parse the entry, set previousHash, and remove entryHash + signature
    let mut entry: serde_json::Value = serde_json::from_str(&input.entry_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse entry: {}", e)))?;

    if let Some(obj) = entry.as_object_mut() {
        obj.insert(
            "previousHash".to_string(),
            serde_json::Value::String(input.previous_hash),
        );
        obj.insert("entryHash".to_string(), serde_json::Value::Null);
        obj.insert("signature".to_string(), serde_json::Value::Null);
    }

    let hash_payload = serde_json::to_string(&entry)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)))?;

    let mut hasher = Sha256::new();
    hasher.update(hash_payload.as_bytes());
    let result = hasher.finalize();
    let entry_hash = hex_util::encode(result);

    let output = ComputeHashOutput { entry_hash };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn sign_entry_hash(input_json: String) -> napi::Result<String> {
    let input: SignInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    let mut mac = HmacSha256::new_from_slice(input.hmac_key.as_bytes())
        .map_err(|e| napi::Error::from_reason(format!("HMAC key error: {}", e)))?;
    mac.update(input.entry_hash.as_bytes());
    let result = mac.finalize();
    let signature = hex_util::encode(result.into_bytes());

    let output = SignOutput { signature };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn verify_chain(input_json: String) -> napi::Result<String> {
    let input: VerifyChainInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    let total = input.entries_json.len();
    if total == 0 {
        let output = VerifyChainOutput {
            valid: true,
            broken_at: None,
            total_entries: 0,
            message: Some("Empty chain".to_string()),
        };
        return serde_json::to_string(&output)
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
    }

    let zeros = "0".repeat(64);
    let mut expected_prev_hash = zeros;

    for (index, entry_str) in input.entries_json.iter().enumerate() {
        let entry: serde_json::Value = match serde_json::from_str(entry_str) {
            Ok(v) => v,
            Err(_) => {
                let output = VerifyChainOutput {
                    valid: false,
                    broken_at: Some(index),
                    total_entries: total,
                    message: Some(format!("Failed to parse entry at line {}", index)),
                };
                return serde_json::to_string(&output)
                    .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
            }
        };

        // Verify previousHash chain
        let prev_hash = entry
            .get("previousHash")
            .and_then(|h| h.as_str())
            .unwrap_or("");
        if prev_hash != expected_prev_hash {
            let output = VerifyChainOutput {
                valid: false,
                broken_at: Some(index),
                total_entries: total,
                message: Some(format!(
                    "Chain broken at entry {}: expected previousHash {}, got {}",
                    index, expected_prev_hash, prev_hash
                )),
            };
            return serde_json::to_string(&output)
                .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
        }

        // Verify entryHash
        let stored_hash = entry
            .get("entryHash")
            .and_then(|h| h.as_str())
            .unwrap_or("")
            .to_string();

        let mut recompute_entry = entry.clone();
        if let Some(obj) = recompute_entry.as_object_mut() {
            obj.insert("entryHash".to_string(), serde_json::Value::Null);
            obj.insert("signature".to_string(), serde_json::Value::Null);
        }

        let recompute_payload = serde_json::to_string(&recompute_entry).unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(recompute_payload.as_bytes());
        let recomputed_hash = hex_util::encode(hasher.finalize());

        if stored_hash != recomputed_hash {
            let output = VerifyChainOutput {
                valid: false,
                broken_at: Some(index),
                total_entries: total,
                message: Some(format!("Entry hash mismatch at entry {}", index)),
            };
            return serde_json::to_string(&output)
                .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
        }

        // Verify HMAC signature if present
        if let Some(sig) = entry.get("signature").and_then(|s| s.as_str()) {
            if !sig.is_empty() {
                let mut mac = HmacSha256::new_from_slice(input.hmac_key.as_bytes())
                    .map_err(|e| napi::Error::from_reason(format!("HMAC key error: {}", e)))?;
                mac.update(stored_hash.as_bytes());
                let expected_sig = hex_util::encode(mac.finalize().into_bytes());
                if sig != expected_sig {
                    let output = VerifyChainOutput {
                        valid: false,
                        broken_at: Some(index),
                        total_entries: total,
                        message: Some(format!("Signature mismatch at entry {}", index)),
                    };
                    return serde_json::to_string(&output).map_err(|e| {
                        napi::Error::from_reason(format!("Failed to serialize: {}", e))
                    });
                }
            }
        }

        expected_prev_hash = stored_hash;
    }

    let output = VerifyChainOutput {
        valid: true,
        broken_at: None,
        total_entries: total,
        message: None,
    };
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)))
}
