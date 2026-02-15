use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ─── Domain Lists ───────────────────────────────────────────────────

const ANALYTICS_DOMAINS: &[&str] = &[
    "segment.io", "segment.com",
    "google-analytics.com", "analytics.google.com", "googletagmanager.com",
    "mixpanel.com",
    "hotjar.com", "hotjar.io",
    "fullstory.com",
    "amplitude.com",
    "heap.io", "heapanalytics.com",
    "sentry.io",
    "newrelic.com",
    "datadog-agent",
    "bugsnag.com",
    "logrocket.com",
];

const FEATURE_FLAG_DOMAINS: &[&str] = &[
    "launchdarkly.com",
    "split.io",
    "optimizely.com",
    "flagsmith.com",
    "statsig.com",
];

const STATIC_EXTENSIONS: &[&str] = &[
    ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".map", ".br", ".gz",
];

const TRACKING_PATTERNS: &[&str] = &[
    "/collect", "/beacon", "/track", "/event", "/pixel",
    "/analytics", "/log", "/ping", "/heartbeat",
];

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilterInput {
    entries: Vec<EntryInput>,
    #[serde(default)]
    overrides: Vec<OverrideInput>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EntryInput {
    request: RequestInput,
    response: ResponseInput,
    started_date_time: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RequestInput {
    method: String,
    url: String,
    body_size: i64,
    #[serde(default)]
    post_data: Option<PostDataInput>,
}

#[derive(Deserialize, Clone)]
struct PostDataInput {
    text: Option<String>,
}

#[derive(Deserialize, Clone)]
struct ResponseInput {
    headers: Vec<HeaderInput>,
}

#[derive(Deserialize, Clone)]
struct HeaderInput {
    name: String,
    value: String,
}

#[derive(Deserialize)]
struct OverrideInput {
    domain: String,
    classification: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilterOutput {
    signal_indices: Vec<usize>,
    noise_indices: Vec<usize>,
    ambiguous_indices: Vec<usize>,
}

// ─── Classification ─────────────────────────────────────────────────

fn matches_domain_list(hostname: &str, domains: &[&str]) -> bool {
    for domain in domains {
        if hostname == *domain || hostname.ends_with(&format!(".{}", domain)) {
            return true;
        }
    }
    false
}

fn get_url_path(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => u.path().to_string(),
        Err(_) => url.to_string(),
    }
}

fn is_static_asset(url_path: &str) -> bool {
    let lower = url_path.to_lowercase();
    STATIC_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

fn is_beacon(entry: &EntryInput) -> bool {
    if entry.request.method.to_uppercase() != "POST" {
        return false;
    }

    let body_size = entry.request.body_size;
    let body_text = entry
        .request
        .post_data
        .as_ref()
        .and_then(|pd| pd.text.as_ref());
    let has_empty_body =
        body_size <= 0 && body_text.map_or(true, |t| t.is_empty());

    if !has_empty_body {
        return false;
    }

    let url_lower = entry.request.url.to_lowercase();
    TRACKING_PATTERNS.iter().any(|p| url_lower.contains(p))
}

fn get_response_content_type(entry: &EntryInput) -> Option<String> {
    entry
        .response
        .headers
        .iter()
        .find(|h| h.name.to_lowercase() == "content-type")
        .map(|h| h.value.clone())
}

fn classify_entry(
    entry: &EntryInput,
    override_map: &HashMap<String, String>,
    polling_urls: &HashSet<String>,
) -> (String, Option<String>) {
    let hostname = match url::Url::parse(&entry.request.url) {
        Ok(u) => u.host_str().unwrap_or("").to_lowercase(),
        Err(_) => return ("ambiguous".to_string(), Some("invalid_url".to_string())),
    };

    // Site-specific overrides
    if let Some(classification) = override_map.get(&hostname) {
        return (classification.clone(), Some("site_override".to_string()));
    }

    // Analytics domains
    if matches_domain_list(&hostname, ANALYTICS_DOMAINS) {
        return ("noise".to_string(), Some("analytics".to_string()));
    }

    // Feature flag domains
    if matches_domain_list(&hostname, FEATURE_FLAG_DOMAINS) {
        return ("noise".to_string(), Some("feature_flag".to_string()));
    }

    // Static assets
    let url_path = get_url_path(&entry.request.url);
    if is_static_asset(&url_path) {
        return ("noise".to_string(), Some("static_asset".to_string()));
    }

    // Beacon detection
    if is_beacon(entry) {
        return ("noise".to_string(), Some("beacon".to_string()));
    }

    // Polling/heartbeat detection
    let sig_key = format!("{}|{}", entry.request.method, entry.request.url);
    if polling_urls.contains(&sig_key) {
        return ("noise".to_string(), Some("polling".to_string()));
    }

    // Non-API content type
    if let Some(ct) = get_response_content_type(entry) {
        if ct.contains("text/html") || ct.contains("text/css") {
            return (
                "ambiguous".to_string(),
                Some("non_api_content_type".to_string()),
            );
        }
    }

    ("signal".to_string(), None)
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn filter_requests(input_json: String) -> napi::Result<String> {
    let input: FilterInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    let mut override_map = HashMap::new();
    for o in &input.overrides {
        override_map.insert(o.domain.to_lowercase(), o.classification.clone());
    }

    // Build polling detection
    let mut sig_map: HashMap<String, Vec<f64>> = HashMap::new();
    for entry in &input.entries {
        let key = format!("{}|{}", entry.request.method, entry.request.url);
        // Simple timestamp approximation - just use index for ordering
        sig_map.entry(key).or_default().push(0.0);
    }

    // Detect polling (3+ identical requests)
    let mut polling_urls = HashSet::new();
    for (key, timestamps) in &sig_map {
        if timestamps.len() >= 3 {
            polling_urls.insert(key.clone());
        }
    }

    let mut signal_indices = Vec::new();
    let mut noise_indices = Vec::new();
    let mut ambiguous_indices = Vec::new();

    for (i, entry) in input.entries.iter().enumerate() {
        let (classification, _reason) = classify_entry(entry, &override_map, &polling_urls);
        match classification.as_str() {
            "noise" => noise_indices.push(i),
            "ambiguous" => ambiguous_indices.push(i),
            _ => signal_indices.push(i),
        }
    }

    let output = FilterOutput {
        signal_indices,
        noise_indices,
        ambiguous_indices,
    };

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}
