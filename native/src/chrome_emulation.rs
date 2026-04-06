//! Custom Chrome 120 (pinned) TLS/HTTP2 emulation profile.
//!
//! Written from scratch to avoid wreq-util (LGPL-3.0).
//! All values are derived from publicly documented Chrome behavior
//! and TLS fingerprint databases.
//!
//! The UA version and fingerprint parameters are pinned to Chrome 120.
//! When updating, also update cipher suites, HTTP/2 settings, and key
//! share parameters to match.

use wreq::{
    Emulation,
    header::{
        ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, CACHE_CONTROL, HeaderMap,
        HeaderValue, OrigHeaderMap, UPGRADE_INSECURE_REQUESTS, USER_AGENT,
    },
    http2::{Http2Options, PseudoId, PseudoOrder, SettingId, SettingsOrder},
    tls::{
        AlpnProtocol, AlpsProtocol, CertificateCompressionAlgorithm,
        TlsOptions, TlsVersion,
    },
};

const CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// Build a Chrome 120 browser fingerprint (pinned version) emulation profile for wreq.
///
/// Configures TLS cipher suites, HTTP/2 settings, ALPN,
/// pseudo-header ordering, and default request headers to
/// match a real Chrome 120 browser fingerprint.
pub fn custom_chrome_emulation() -> Emulation {
    Emulation::builder()
        .tls_options(chrome_tls_options())
        .http2_options(chrome_http2_options())
        .headers(chrome_default_headers())
        .orig_headers(chrome_orig_headers())
        .build()
}

// ── TLS options ────────────────────────────────────────────────────────

fn chrome_tls_options() -> TlsOptions {
    TlsOptions::builder()
        // ALPN: h2 first, then http/1.1 (Chrome order)
        .alpn_protocols([AlpnProtocol::HTTP2, AlpnProtocol::HTTP1])
        // ALPS for HTTP/2
        .alps_protocols([AlpsProtocol::HTTP2])
        .alps_use_new_codepoint(true)
        // TLS version range
        .min_tls_version(TlsVersion::TLS_1_2)
        .max_tls_version(TlsVersion::TLS_1_3)
        // Session tickets enabled (Chrome default)
        .session_ticket(true)
        // Chrome enables OCSP stapling and SCTs
        .enable_ocsp_stapling(true)
        .enable_signed_cert_timestamps(true)
        // ECH GREASE — Chrome sends this
        .enable_ech_grease(true)
        // Chrome permutes extensions
        .permute_extensions(true)
        // GREASE enabled (Chrome sends GREASE values)
        .grease_enabled(true)
        // Chrome cipher suite order (BoringSSL cipher string)
        .cipher_list(
            "TLS_AES_128_GCM_SHA256:\
             TLS_AES_256_GCM_SHA384:\
             TLS_CHACHA20_POLY1305_SHA256:\
             ECDHE-ECDSA-AES128-GCM-SHA256:\
             ECDHE-RSA-AES128-GCM-SHA256:\
             ECDHE-ECDSA-AES256-GCM-SHA384:\
             ECDHE-RSA-AES256-GCM-SHA384:\
             ECDHE-ECDSA-CHACHA20-POLY1305:\
             ECDHE-RSA-CHACHA20-POLY1305:\
             ECDHE-RSA-AES128-SHA:\
             ECDHE-RSA-AES256-SHA:\
             AES128-GCM-SHA256:\
             AES256-GCM-SHA384:\
             AES128-SHA:\
             AES256-SHA",
        )
        // Elliptic curves matching Chrome 120
        .curves_list("X25519:P-256:P-384")
        // Signature algorithms matching Chrome 120
        .sigalgs_list(
            "ecdsa_secp256r1_sha256:\
             rsa_pss_rsae_sha256:\
             rsa_pkcs1_sha256:\
             ecdsa_secp384r1_sha384:\
             rsa_pss_rsae_sha384:\
             rsa_pkcs1_sha384:\
             rsa_pss_rsae_sha512:\
             rsa_pkcs1_sha512",
        )
        // Certificate compression: Chrome supports brotli and zlib; only brotli configured here to match the most common Chrome 120 fingerprint.
        .certificate_compression_algorithms(vec![
            CertificateCompressionAlgorithm::BROTLI,
        ])
        // PSK/DHE key exchange
        .pre_shared_key(false)
        .psk_dhe_ke(true)
        // Key share limit: Chrome sends 2 key shares (X25519 + P-256)
        .key_shares_limit(2u8)
        // Record size limit (Chrome default)
        .record_size_limit(0x4001u16)
        // Renegotiation info extension
        .renegotiation(true)
        .build()
}

// ── HTTP/2 options ─────────────────────────────────────────────────────

fn chrome_http2_options() -> Http2Options {
    Http2Options::builder()
        // Chrome HTTP/2 window sizes
        .initial_window_size(6_291_456u32)           // 6 MiB
        .initial_connection_window_size(15_728_640u32) // 15 MiB
        // Max frame size: 16384 (Chrome default, same as spec)
        .max_frame_size(16_384u32)
        // Header table size: 65536 (Chrome uses 64KB HPACK table)
        .header_table_size(65_536u32)
        // Max header list size: 262144 (Chrome default)
        .max_header_list_size(262_144u32)
        // Chrome sends ENABLE_PUSH = 0
        .enable_push(false)
        // Chrome pseudo-header order: :method, :authority, :scheme, :path
        .headers_pseudo_order(
            PseudoOrder::builder()
                .push(PseudoId::Method)
                .push(PseudoId::Authority)
                .push(PseudoId::Scheme)
                .push(PseudoId::Path)
                .build(),
        )
        // Chrome SETTINGS frame order
        .settings_order(chrome_settings_order())
        .build()
}

/// Chrome sends SETTINGS in this specific order:
///   HEADER_TABLE_SIZE, ENABLE_PUSH, MAX_CONCURRENT_STREAMS,
///   INITIAL_WINDOW_SIZE, MAX_FRAME_SIZE, MAX_HEADER_LIST_SIZE
fn chrome_settings_order() -> SettingsOrder {
    SettingsOrder::builder()
        .push(SettingId::HeaderTableSize)
        .push(SettingId::EnablePush)
        .push(SettingId::MaxConcurrentStreams)
        .push(SettingId::InitialWindowSize)
        .push(SettingId::MaxFrameSize)
        .push(SettingId::MaxHeaderListSize)
        .build()
}

// ── Default headers ────────────────────────────────────────────────────

fn chrome_default_headers() -> HeaderMap {
    let mut headers = HeaderMap::with_capacity(6);
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(CHROME_UA),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,\
             image/avif,image/webp,image/apng,*/*;q=0.8,\
             application/signed-exchange;v=b3;q=0.7",
        ),
    );
    headers.insert(
        ACCEPT_LANGUAGE,
        HeaderValue::from_static("en-US,en;q=0.9"),
    );
    headers.insert(
        ACCEPT_ENCODING,
        HeaderValue::from_static("gzip, deflate, br"),
    );
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("max-age=0"),
    );
    headers.insert(
        UPGRADE_INSECURE_REQUESTS,
        HeaderValue::from_static("1"),
    );
    headers
}

/// Original header casing as Chrome sends them.
fn chrome_orig_headers() -> OrigHeaderMap {
    let mut orig = OrigHeaderMap::new();
    orig.insert("User-Agent");
    orig.insert("Accept");
    orig.insert("Accept-Language");
    orig.insert("Accept-Encoding");
    orig.insert("Cache-Control");
    orig.insert("Upgrade-Insecure-Requests");
    orig
}
