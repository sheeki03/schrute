use ipnet::IpNet;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::str::FromStr;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IpValidationResult {
    ip: String,
    allowed: bool,
    category: String,
}

// ─── Blocked CIDR Ranges ────────────────────────────────────────────

const BLOCKED_V4_CIDRS: &[&str] = &[
    "10.0.0.0/8",       // Private
    "172.16.0.0/12",     // Private
    "192.168.0.0/16",    // Private
    "127.0.0.0/8",       // Loopback
    "169.254.0.0/16",    // Link-local
    "100.64.0.0/10",     // CGNAT
    "192.0.2.0/24",      // Documentation (TEST-NET-1)
    "198.51.100.0/24",   // Documentation (TEST-NET-2)
    "203.0.113.0/24",    // Documentation (TEST-NET-3)
    "198.18.0.0/15",     // Benchmarking
    "0.0.0.0/8",         // "This" network
    "255.255.255.255/32", // Broadcast
    "224.0.0.0/4",       // Multicast
    "240.0.0.0/4",       // Reserved
];

const BLOCKED_V6_CIDRS: &[&str] = &[
    "::1/128",           // Loopback
    "::/128",            // Unspecified
    "::ffff:0:0/96",     // IPv4-mapped
    "fc00::/7",          // Unique local
    "fe80::/10",         // Link-local
    "ff00::/8",          // Multicast
    "64:ff9b::/96",      // NAT64
    "100::/64",          // Discard
    "2001:db8::/32",     // Documentation
    "2001::/32",         // Teredo
    "2002::/16",         // 6to4
];

fn is_blocked_ip(ip: &IpAddr) -> (bool, String) {
    let cidrs = match ip {
        IpAddr::V4(_) => BLOCKED_V4_CIDRS,
        IpAddr::V6(v6) => {
            // Check if IPv4-mapped
            if let Some(v4) = v6.to_ipv4_mapped() {
                let v4_addr = IpAddr::V4(v4);
                let (blocked, category) = is_blocked_ip(&v4_addr);
                if blocked {
                    return (true, format!("ipv4_mapped:{}", category));
                }
                return (false, "unicast".to_string());
            }
            BLOCKED_V6_CIDRS
        }
    };

    for cidr_str in cidrs {
        if let Ok(cidr) = IpNet::from_str(cidr_str) {
            if cidr.contains(ip) {
                let category = categorize_cidr(cidr_str);
                return (true, category);
            }
        }
    }

    (false, "unicast".to_string())
}

fn categorize_cidr(cidr: &str) -> String {
    match cidr {
        "10.0.0.0/8" | "172.16.0.0/12" | "192.168.0.0/16" => "private".to_string(),
        "127.0.0.0/8" | "::1/128" => "loopback".to_string(),
        "169.254.0.0/16" | "fe80::/10" => "linkLocal".to_string(),
        "100.64.0.0/10" => "carrierGradeNat".to_string(),
        "0.0.0.0/8" | "::/128" => "unspecified".to_string(),
        "255.255.255.255/32" => "broadcast".to_string(),
        "224.0.0.0/4" | "ff00::/8" => "multicast".to_string(),
        "240.0.0.0/4" => "reserved".to_string(),
        "fc00::/7" => "uniqueLocal".to_string(),
        "::ffff:0:0/96" => "ipv4Mapped".to_string(),
        _ => "blocked".to_string(),
    }
}

// ─── Domain Normalization ───────────────────────────────────────────

fn normalize_domain(domain: &str) -> String {
    let mut d = domain.to_lowercase();
    while d.ends_with('.') {
        d.pop();
    }
    // IDN/punycode normalization
    match idna::domain_to_ascii(&d) {
        Ok(ascii) => ascii,
        Err(_) => d,
    }
}

// ─── Public API ─────────────────────────────────────────────────────

#[napi]
pub fn is_public_ip(ip_str: String) -> napi::Result<String> {
    let ip: IpAddr = ip_str
        .parse()
        .map_err(|e| napi::Error::from_reason(format!("Invalid IP address: {}", e)))?;

    let (blocked, category) = is_blocked_ip(&ip);

    let result = IpValidationResult {
        ip: ip_str,
        allowed: !blocked,
        category,
    };

    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)))
}

#[napi]
pub fn normalize_domain_native(domain: String) -> String {
    normalize_domain(&domain)
}

#[napi]
pub fn check_domain_allowlist(input_json: String) -> napi::Result<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        target_domain: String,
        allowlist: Vec<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Output {
        allowed: bool,
        matched_domain: Option<String>,
    }

    let input: Input = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input: {}", e)))?;

    let normalized_target = normalize_domain(&input.target_domain);

    for allowed in &input.allowlist {
        let normalized_allowed = normalize_domain(allowed);
        if normalized_target == normalized_allowed
            || normalized_target.ends_with(&format!(".{}", normalized_allowed))
        {
            return serde_json::to_string(&Output {
                allowed: true,
                matched_domain: Some(allowed.clone()),
            })
            .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)));
        }
    }

    serde_json::to_string(&Output {
        allowed: false,
        matched_domain: None,
    })
    .map_err(|e| napi::Error::from_reason(format!("Failed to serialize: {}", e)))
}
