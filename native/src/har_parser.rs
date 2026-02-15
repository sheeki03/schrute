use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── HAR 1.2 Input Types ────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarData {
    log: HarLog,
}

#[derive(Deserialize)]
struct HarLog {
    entries: Vec<HarEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarEntry {
    started_date_time: String,
    time: f64,
    request: HarRequest,
    response: HarResponse,
    #[serde(default, rename = "serverIPAddress")]
    server_ip_address: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarRequest {
    method: String,
    url: String,
    headers: Vec<HarHeader>,
    query_string: Vec<HarQueryParam>,
    post_data: Option<HarPostData>,
}

#[derive(Deserialize)]
struct HarResponse {
    status: u16,
    #[serde(rename = "statusText")]
    status_text: String,
    headers: Vec<HarHeader>,
    content: HarContent,
}

#[derive(Deserialize)]
struct HarHeader {
    name: String,
    value: String,
}

#[derive(Deserialize)]
struct HarQueryParam {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarPostData {
    mime_type: String,
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarContent {
    mime_type: String,
    text: Option<String>,
}

// ─── Output Types ───────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StructuredRecord {
    request: StructuredRequest,
    response: StructuredResponse,
    started_at: f64,
    duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_ip: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StructuredRequest {
    method: String,
    url: String,
    headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    query_params: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StructuredResponse {
    status: u16,
    status_text: String,
    headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
}

// ─── Timestamp Parsing ──────────────────────────────────────────────

fn parse_iso_timestamp_ms(s: &str) -> f64 {
    // Parse ISO 8601 to milliseconds since epoch
    // Simple approach: handle common formats
    // Format: "2024-01-15T12:00:00.000Z" or with offset
    let s = s.trim();

    // Try to parse using a simple manual approach
    // We need to handle: YYYY-MM-DDThh:mm:ss.sssZ
    if s.len() < 19 {
        return 0.0;
    }

    let year: i64 = s[0..4].parse().unwrap_or(1970);
    let month: i64 = s[5..7].parse().unwrap_or(1);
    let day: i64 = s[8..10].parse().unwrap_or(1);
    let hour: i64 = s[11..13].parse().unwrap_or(0);
    let min: i64 = s[14..16].parse().unwrap_or(0);
    let sec: i64 = s[17..19].parse().unwrap_or(0);

    let mut millis: f64 = 0.0;
    if s.len() > 20 && &s[19..20] == "." {
        let end = s[20..].find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len() - 20);
        let frac_str = &s[20..20 + end];
        if !frac_str.is_empty() {
            let frac: f64 = frac_str.parse().unwrap_or(0.0);
            let divisor = 10f64.powi(frac_str.len() as i32);
            millis = (frac / divisor) * 1000.0;
        }
    }

    // Days from year (simplified, not accounting for leap years perfectly but sufficient)
    let days_from_year = (year - 1970) * 365 + (year - 1969) / 4 - (year - 1901) / 100 + (year - 1601) / 400;
    let month_days: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let is_leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let leap_add = if is_leap && month > 2 { 1 } else { 0 };
    let days_from_month = month_days[(month - 1) as usize] + leap_add;

    let total_days = days_from_year + days_from_month + (day - 1);
    let total_seconds = total_days * 86400 + hour * 3600 + min * 60 + sec;

    (total_seconds as f64) * 1000.0 + millis
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn parse_har(har_json: String) -> napi::Result<String> {
    let har_data: HarData = serde_json::from_str(&har_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse HAR JSON: {}", e)))?;

    let records: Vec<StructuredRecord> = har_data
        .log
        .entries
        .into_iter()
        .map(|entry| {
            let mut req_headers = HashMap::new();
            for h in &entry.request.headers {
                req_headers.insert(h.name.to_lowercase(), h.value.clone());
            }

            let mut query_params = HashMap::new();
            for q in &entry.request.query_string {
                query_params.insert(q.name.clone(), q.value.clone());
            }

            let mut resp_headers = HashMap::new();
            for h in &entry.response.headers {
                resp_headers.insert(h.name.to_lowercase(), h.value.clone());
            }

            let content_type = entry
                .request
                .post_data
                .as_ref()
                .map(|pd| pd.mime_type.clone())
                .or_else(|| req_headers.get("content-type").cloned());

            StructuredRecord {
                request: StructuredRequest {
                    method: entry.request.method,
                    url: entry.request.url,
                    headers: req_headers,
                    body: entry.request.post_data.as_ref().and_then(|pd| pd.text.clone()),
                    content_type,
                    query_params,
                },
                response: StructuredResponse {
                    status: entry.response.status,
                    status_text: entry.response.status_text,
                    headers: resp_headers,
                    body: entry.response.content.text.clone(),
                    content_type: Some(entry.response.content.mime_type),
                },
                started_at: parse_iso_timestamp_ms(&entry.started_date_time),
                duration: entry.time,
                server_ip: entry.server_ip_address,
            }
        })
        .collect();

    serde_json::to_string(&records)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize result: {}", e)))
}
