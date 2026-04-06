//! Sync napi binding for wreq-based TLS fetch.
//!
//! The JS-visible ABI is synchronous (`fn(String) -> napi::Result<String>`).
//! Internally we block on a shared tokio runtime via `OnceLock<Option<Runtime>>`.

use std::sync::OnceLock;
use std::time::Duration;

use napi_derive::napi;
use serde::{Deserialize, Serialize};

use crate::chrome_emulation::custom_chrome_emulation;

// NOTE: OnceLock caches the value permanently. If runtime creation fails,
// all subsequent tls_fetch calls will fail with "resource exhaustion" without
// retrying. This is acceptable because tokio runtime failure is non-transient
// (thread/fd limits) and retrying would just fail again.
static RT: OnceLock<Option<tokio::runtime::Runtime>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TlsFetchInput {
    url: String,
    method: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
    timeout_ms: u64,
    max_response_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TlsFetchOutput {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    body: String,
}

/// Perform a TLS-fingerprinted HTTP request using wreq with Chrome emulation.
///
/// Accepts a JSON string conforming to `TlsFetchInput` and returns a JSON
/// string conforming to `TlsFetchOutput`. The call blocks the current thread
/// until the async request completes.
///
/// # Invariants
/// - Redirects are suppressed (`Policy::none()`).
/// - All response header keys are lowercased.
/// - Response body is capped at `max_response_bytes` (fail-closed via streaming).
#[napi]
pub fn tls_fetch(input_json: String) -> napi::Result<String> {
    let input: TlsFetchInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid input JSON: {e}")))?;

    let rt = RT.get_or_init(|| {
        match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
        {
            Ok(rt) => Some(rt),
            Err(e) => {
                eprintln!("wreq: tokio runtime creation failed: {e}");
                None
            }
        }
    });
    let rt = rt.as_ref().ok_or_else(|| {
        napi::Error::from_reason("Failed to create tokio runtime — resource exhaustion")
    })?;

    rt.block_on(async {
        let client = wreq::Client::builder()
            .redirect(wreq::redirect::Policy::none()) // INVARIANT: no redirects
            .emulation(custom_chrome_emulation())
            .timeout(Duration::from_millis(input.timeout_ms))
            .build()
            .map_err(|e| napi::Error::from_reason(format!("Client build failed: {e}")))?;

        let method: wreq::Method = input
            .method
            .parse()
            .map_err(|e| napi::Error::from_reason(format!("Invalid method: {e}")))?;

        let mut req_builder = client.request(method, &input.url);

        for (key, value) in &input.headers {
            req_builder = req_builder.header(key.as_str(), value.as_str());
        }

        if let Some(body) = input.body {
            req_builder = req_builder.body(body);
        }

        let resp = req_builder
            .send()
            .await
            .map_err(|e| napi::Error::from_reason(format!("Request failed: {e}")))?;

        let status = resp.status().as_u16();

        // INVARIANT: lowercase all header keys
        let headers: std::collections::HashMap<String, String> = resp
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_lowercase(),
                    v.to_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|_| String::from_utf8_lossy(v.as_bytes()).into_owned()),
                )
            })
            .collect();

        // INVARIANT: fail-closed body cap via streaming
        let max = usize::try_from(input.max_response_bytes).unwrap_or(usize::MAX);
        let mut body_bytes = Vec::new();
        let mut stream = resp;
        while let Some(chunk) = stream
            .chunk()
            .await
            .map_err(|e| napi::Error::from_reason(format!("Body read failed: {e}")))?
        {
            body_bytes.extend_from_slice(&chunk);
            if body_bytes.len() > max {
                return Err(napi::Error::from_reason(format!(
                    "Body exceeded {} bytes",
                    max
                )));
            }
        }

        let body = String::from_utf8_lossy(&body_bytes).into_owned();

        let output = TlsFetchOutput {
            status,
            headers,
            body,
        };
        serde_json::to_string(&output)
            .map_err(|e| napi::Error::from_reason(format!("Output serialization failed: {e}")))
    })
}
