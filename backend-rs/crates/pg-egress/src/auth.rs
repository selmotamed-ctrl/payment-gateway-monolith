//! Gateway authentication methods and request signatures.
//!
//! Port of `GatewayAuthMethod` / `AuthApply` / `GatewayAuthConfig` and the
//! `applyAuthentication` / `requestToken` branches in
//! `core-back/engine/apiConsumer/ApiConsumer.ts:9-57`, `:639-723`, `:764-893`.
//!
//! The real method list is ten entries (verified against the TS union): `NONE`, `API_KEY`,
//! `PERMANENT_TOKEN`, `TOKEN_ENDPOINT`, `REFRESH_TOKEN`, `USERNAME_PASSWORD`, `BASIC`,
//! `REQUEST_SIGNATURE`, `OAUTH2_CLIENT_CREDENTIALS`, `MUTUAL_TLS`. `API_KEY` has three placements
//! (`HEADER`/`QUERY`/`BODY`); `REQUEST_SIGNATURE` has two HMAC algorithms.
//!
//! Signing reuses [`pg_crypto`]'s HMAC and output encoders; the gateway `CryptoEngine`
//! canonicalisation is re-exported below so a caller never re-implements it.

#![forbid(unsafe_code)]

pub use pg_crypto::{canonicalize, canonicalize_with, CanonicalizationInput, CanonicalizationMode};

use pg_crypto::{encode_output, hmac_sha256, hmac_sha512, OutputEncoding};

/// Default header for `API_KEY`.
///
/// Port of `this.config.auth.header_name ?? "X-API-KEY"` (`ApiConsumer.ts:655`).
pub const DEFAULT_API_KEY_HEADER: &str = "X-API-KEY";
/// Default query parameter for `API_KEY` with `apply: QUERY`.
pub const DEFAULT_QUERY_NAME: &str = "api_key";
/// Default body field for `API_KEY` with `apply: BODY`.
pub const DEFAULT_BODY_NAME: &str = "api_key";
/// Default timestamp header for `REQUEST_SIGNATURE`.
pub const DEFAULT_TIMESTAMP_HEADER: &str = "X-Timestamp";
/// Default signature header for `REQUEST_SIGNATURE`.
pub const DEFAULT_SIGNATURE_HEADER: &str = "X-Signature";

/// Where `API_KEY` is applied (`AuthApply`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuthPlacement {
    Header,
    Query,
    Body,
}

impl AuthPlacement {
    /// TS defaults to `HEADER` for every method (`defaultApply`, `ApiConsumer.ts:725-727`).
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "HEADER" => Self::Header,
            "QUERY" => Self::Query,
            "BODY" => Self::Body,
            _ => return None,
        })
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Header => "HEADER",
            Self::Query => "QUERY",
            Self::Body => "BODY",
        }
    }
}

/// The HMAC used by `REQUEST_SIGNATURE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SignatureAlgorithm {
    HmacSha256,
    HmacSha512,
}

impl SignatureAlgorithm {
    /// `HMAC_SHA256` is the TS default (`ApiConsumer.ts:705`).
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "HMAC_SHA256" => Self::HmacSha256,
            "HMAC_SHA512" => Self::HmacSha512,
            _ => return None,
        })
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HmacSha256 => "HMAC_SHA256",
            Self::HmacSha512 => "HMAC_SHA512",
        }
    }
}

/// The ten gateway authentication methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ApiConsumerAuth {
    None,
    ApiKey { placement: AuthPlacement },
    PermanentToken,
    TokenEndpoint,
    RefreshToken,
    UsernamePassword,
    Basic,
    RequestSignature { algorithm: SignatureAlgorithm },
    OAuth2ClientCredentials,
    MutualTls,
}

impl ApiConsumerAuth {
    /// The ten methods in TS declaration order.
    #[must_use]
    pub const fn all() -> [Self; 10] {
        [
            Self::None,
            Self::ApiKey {
                placement: AuthPlacement::Header,
            },
            Self::PermanentToken,
            Self::TokenEndpoint,
            Self::RefreshToken,
            Self::UsernamePassword,
            Self::Basic,
            Self::RequestSignature {
                algorithm: SignatureAlgorithm::HmacSha256,
            },
            Self::OAuth2ClientCredentials,
            Self::MutualTls,
        ]
    }

    /// Parse the stored `auth.method` value; case-sensitive like the TS enum.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "NONE" => Self::None,
            "API_KEY" => Self::ApiKey {
                placement: AuthPlacement::Header,
            },
            "PERMANENT_TOKEN" => Self::PermanentToken,
            "TOKEN_ENDPOINT" => Self::TokenEndpoint,
            "REFRESH_TOKEN" => Self::RefreshToken,
            "USERNAME_PASSWORD" => Self::UsernamePassword,
            "BASIC" => Self::Basic,
            "REQUEST_SIGNATURE" => Self::RequestSignature {
                algorithm: SignatureAlgorithm::HmacSha256,
            },
            "OAUTH2_CLIENT_CREDENTIALS" => Self::OAuth2ClientCredentials,
            "MUTUAL_TLS" => Self::MutualTls,
            _ => return None,
        })
    }

    /// The canonical TS name (independent of the placement/algorithm sub-options).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "NONE",
            Self::ApiKey { .. } => "API_KEY",
            Self::PermanentToken => "PERMANENT_TOKEN",
            Self::TokenEndpoint => "TOKEN_ENDPOINT",
            Self::RefreshToken => "REFRESH_TOKEN",
            Self::UsernamePassword => "USERNAME_PASSWORD",
            Self::Basic => "BASIC",
            Self::RequestSignature { .. } => "REQUEST_SIGNATURE",
            Self::OAuth2ClientCredentials => "OAUTH2_CLIENT_CREDENTIALS",
            Self::MutualTls => "MUTUAL_TLS",
        }
    }

    /// Set the placement of `API_KEY` (ignored for every other method).
    #[must_use]
    pub const fn with_placement(self, placement: AuthPlacement) -> Self {
        match self {
            Self::ApiKey { .. } => Self::ApiKey { placement },
            other => other,
        }
    }

    /// Set the algorithm of `REQUEST_SIGNATURE` (ignored for every other method).
    #[must_use]
    pub const fn with_algorithm(self, algorithm: SignatureAlgorithm) -> Self {
        match self {
            Self::RequestSignature { .. } => Self::RequestSignature { algorithm },
            other => other,
        }
    }

    /// The placement of this method (`HEADER` unless it is an `API_KEY`).
    #[must_use]
    pub const fn placement(self) -> AuthPlacement {
        match self {
            Self::ApiKey { placement } => placement,
            _ => AuthPlacement::Header,
        }
    }

    /// The algorithm of `REQUEST_SIGNATURE`.
    #[must_use]
    pub const fn signature_algorithm(self) -> Option<SignatureAlgorithm> {
        match self {
            Self::RequestSignature { algorithm } => Some(algorithm),
            _ => None,
        }
    }

    /// Methods whose first use calls the token endpoint.
    ///
    /// Port of `performRefresh` (`ApiConsumer.ts:729-762`): every method outside the fixed
    /// no-token set requires `token_endpoint`/`refresh_url`.
    #[must_use]
    pub const fn needs_token_refresh(self) -> bool {
        matches!(
            self,
            Self::TokenEndpoint
                | Self::RefreshToken
                | Self::UsernamePassword
                | Self::OAuth2ClientCredentials
        )
    }

    /// Per-credential-set client certificates (`mtls_cert_ciphertext`).
    #[must_use]
    pub const fn requires_client_certificate(self) -> bool {
        matches!(self, Self::MutualTls)
    }

    /// `Authorization: Bearer <accessToken>` is set for every token method.
    #[must_use]
    pub const fn uses_bearer_token(self) -> bool {
        self.needs_token_refresh()
    }

    /// The default header for this method (`Authorization` unless noted).
    #[must_use]
    pub const fn default_header_name(self) -> &'static str {
        match self {
            Self::ApiKey { .. } => DEFAULT_API_KEY_HEADER,
            Self::RequestSignature { .. } => DEFAULT_SIGNATURE_HEADER,
            _ => "Authorization",
        }
    }

    /// The default query name for `API_KEY` with `apply: QUERY`.
    #[must_use]
    pub const fn default_query_name(self) -> &'static str {
        DEFAULT_QUERY_NAME
    }

    /// The default body field for `API_KEY` with `apply: BODY`.
    #[must_use]
    pub const fn default_body_name(self) -> &'static str {
        DEFAULT_BODY_NAME
    }
}

/// HMAC-SHA256/512 over an already-canonical payload, lowercase hex.
///
/// `REQUEST_SIGNATURE` canonicalises as `"{timestamp}.{payload}"`; a gateway profile that declares
/// another `CryptoEngine` canonicalisation mode signs the canonical string itself, so the two HMAC
/// primitives are kept together.
#[must_use]
pub fn sign_payload(secret: &str, payload: &str, algorithm: SignatureAlgorithm) -> String {
    let digest = match algorithm {
        SignatureAlgorithm::HmacSha256 => hmac_sha256(secret.as_bytes(), payload.as_bytes()),
        SignatureAlgorithm::HmacSha512 => hmac_sha512(secret.as_bytes(), payload.as_bytes()),
    };
    encode_output(&digest, OutputEncoding::HexLower)
}

/// Sign `"{timestamp}.{payload}"` for `REQUEST_SIGNATURE`.
///
/// Port of `applyAuthentication`'s digest (`ApiConsumer.ts:703-710`): the timestamp is Unix
/// seconds, the payload is the exact transmitted text (`payloadToString`), and the output is
/// lowercase hex. TS also forwards `X-API-KEY` when an `apiKey` credential exists; the caller does
/// that, because this function is kept pure.
#[must_use]
pub fn sign_request(
    secret: &str,
    timestamp_seconds: i64,
    payload: &str,
    algorithm: SignatureAlgorithm,
) -> String {
    sign_payload(secret, &format!("{timestamp_seconds}.{payload}"), algorithm)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TS_NAMES: [&str; 10] = [
        "NONE",
        "API_KEY",
        "PERMANENT_TOKEN",
        "TOKEN_ENDPOINT",
        "REFRESH_TOKEN",
        "USERNAME_PASSWORD",
        "BASIC",
        "REQUEST_SIGNATURE",
        "OAUTH2_CLIENT_CREDENTIALS",
        "MUTUAL_TLS",
    ];

    #[test]
    fn the_method_list_is_the_ten_ts_methods() {
        assert_eq!(ApiConsumerAuth::all().len(), TS_NAMES.len());
        for (index, name) in TS_NAMES.iter().enumerate() {
            let method = ApiConsumerAuth::parse(name).expect(name);
            assert_eq!(method.as_str(), *name);
            assert_eq!(ApiConsumerAuth::all()[index].as_str(), *name);
        }
        assert_eq!(ApiConsumerAuth::parse("API_KEY_HEADER"), None);
        assert_eq!(ApiConsumerAuth::parse("api_key"), None);
    }

    #[test]
    fn placements_and_algorithms_are_explicit() {
        assert_eq!(AuthPlacement::parse("QUERY"), Some(AuthPlacement::Query));
        assert_eq!(AuthPlacement::parse("BODY"), Some(AuthPlacement::Body));
        assert_eq!(AuthPlacement::parse("COOKIE"), None);
        assert_eq!(AuthPlacement::Body.as_str(), "BODY");

        let api_key = ApiConsumerAuth::parse("API_KEY")
            .expect("api key")
            .with_placement(AuthPlacement::Query);
        assert_eq!(api_key.placement(), AuthPlacement::Query);
        assert_eq!(api_key.as_str(), "API_KEY");

        let signature = ApiConsumerAuth::parse("REQUEST_SIGNATURE")
            .expect("signature")
            .with_algorithm(SignatureAlgorithm::HmacSha512);
        assert_eq!(
            signature.signature_algorithm(),
            Some(SignatureAlgorithm::HmacSha512)
        );
        assert_eq!(signature.default_header_name(), DEFAULT_SIGNATURE_HEADER);
        assert_eq!(
            SignatureAlgorithm::parse("HMAC_SHA512"),
            Some(SignatureAlgorithm::HmacSha512)
        );
        assert_eq!(SignatureAlgorithm::parse("HMAC_MD5"), None);
    }

    #[test]
    fn method_capabilities_match_the_ts_branches() {
        for method in [
            ApiConsumerAuth::TokenEndpoint,
            ApiConsumerAuth::RefreshToken,
            ApiConsumerAuth::UsernamePassword,
            ApiConsumerAuth::OAuth2ClientCredentials,
        ] {
            assert!(method.needs_token_refresh(), "{method:?}");
            assert!(method.uses_bearer_token(), "{method:?}");
        }
        for method in [
            ApiConsumerAuth::None,
            ApiConsumerAuth::PermanentToken,
            ApiConsumerAuth::Basic,
            ApiConsumerAuth::RequestSignature {
                algorithm: SignatureAlgorithm::HmacSha256,
            },
            ApiConsumerAuth::MutualTls,
        ] {
            assert!(!method.needs_token_refresh(), "{method:?}");
        }
        assert!(ApiConsumerAuth::MutualTls.requires_client_certificate());
        assert!(!ApiConsumerAuth::Basic.requires_client_certificate());
        assert_eq!(
            ApiConsumerAuth::ApiKey {
                placement: AuthPlacement::Header
            }
            .default_header_name(),
            "X-API-KEY"
        );
        assert_eq!(
            ApiConsumerAuth::PermanentToken.default_header_name(),
            "Authorization"
        );
        assert_eq!(
            ApiConsumerAuth::ApiKey {
                placement: AuthPlacement::Query
            }
            .default_query_name(),
            "api_key"
        );
    }

    #[test]
    fn signatures_are_lowercase_hex_of_the_timestamp_and_payload() {
        let sha256 = sign_request(
            "secret",
            1_700_000_000,
            "{\"amount\":1}",
            SignatureAlgorithm::HmacSha256,
        );
        assert_eq!(sha256.len(), 64);
        assert!(sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
        assert_eq!(
            sha256,
            encode_output(
                &hmac_sha256(b"secret", b"1700000000.{\"amount\":1}"),
                OutputEncoding::HexLower
            )
        );

        let sha512 = sign_request(
            "secret",
            1_700_000_000,
            "{\"amount\":1}",
            SignatureAlgorithm::HmacSha512,
        );
        assert_eq!(sha512.len(), 128);
        assert_ne!(sha256, sha512);
        assert_ne!(
            sha256,
            sign_request(
                "secret",
                1_700_000_001,
                "{\"amount\":1}",
                SignatureAlgorithm::HmacSha256
            )
        );
        assert_ne!(
            sha256,
            sign_request(
                "other",
                1_700_000_000,
                "{\"amount\":1}",
                SignatureAlgorithm::HmacSha256
            )
        );
        // An empty payload signs the timestamp and the dot, exactly like `payloadToString(null)`.
        assert_eq!(
            sign_request("secret", 1, "", SignatureAlgorithm::HmacSha256),
            encode_output(&hmac_sha256(b"secret", b"1."), OutputEncoding::HexLower)
        );
        assert_eq!(
            sign_request("secret", 1, "x", SignatureAlgorithm::HmacSha256),
            sign_payload("secret", "1.x", SignatureAlgorithm::HmacSha256)
        );
        assert_eq!(
            sign_payload("secret", "1.x", SignatureAlgorithm::HmacSha512),
            sign_request("secret", 1, "x", SignatureAlgorithm::HmacSha512)
        );
    }
}
