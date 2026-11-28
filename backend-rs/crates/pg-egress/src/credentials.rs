//! Gateway credential maps and the authentication configuration.
//!
//! Port of `GatewayAuthConfig` / `CredentialEntry[]` / `credentialMap` / `firstCredential` and the
//! `applyAuthentication` branches in `core-back/engine/apiConsumer/ApiConsumer.ts:25-57`,
//! `:312-355`, `:639-723`.
//!
//! The ten methods are modelled by [`ApiConsumerAuth`]; this module owns the *configuration*
//! (header/query/body names, token selectors, signature options) and the pure "what goes on the
//! wire" rules. Network I/O and token caching live in [`crate::executor`].

#![forbid(unsafe_code)]

use std::fmt;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Map, Value};

use pg_crypto::canonical::{
    canonicalize, CanonicalError, CanonicalizationInput, CanonicalizationMode,
};

use crate::auth::{
    sign_payload, sign_request, ApiConsumerAuth, AuthPlacement, SignatureAlgorithm,
    DEFAULT_API_KEY_HEADER, DEFAULT_BODY_NAME, DEFAULT_QUERY_NAME, DEFAULT_SIGNATURE_HEADER,
    DEFAULT_TIMESTAMP_HEADER,
};
use crate::body::PreparedBody;

/// Credential names tried for `API_KEY`, in TS order (`ApiConsumer.ts:651`).
pub const API_KEY_NAMES: [&str; 3] = ["apiKey", "api_key", "key"];
/// Credential names tried for `MUTUAL_TLS` material (`ApiConsumer.ts:954-956`).
pub const TLS_CERTIFICATE_NAMES: [&str; 3] = ["certificate", "cert", "mtlsCert"];
pub const TLS_PRIVATE_KEY_NAMES: [&str; 3] = ["privateKey", "key", "mtlsKey"];
pub const TLS_CA_NAMES: [&str; 3] = ["ca", "caCertificate", "mtlsCa"];

/// An ordered credential map (`credentialMap`, `ApiConsumer.ts:312-329`).
///
/// Ordered because [`Self::first`] must reproduce the TS lookup order; `Debug` prints the keys only,
/// because a value is a secret (a gateway API key, a client secret, an HMAC secret, a private key).
#[derive(Clone, Default, PartialEq, Eq)]
pub struct GatewayCredentials {
    entries: Vec<(String, String)>,
}

impl GatewayCredentials {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Build from pairs; a later duplicate key replaces the earlier value, like
    /// `output[entry.key] = entry.value` in TS.
    #[must_use]
    pub fn from_pairs(
        pairs: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
    ) -> Self {
        let mut credentials = Self::new();
        for (key, value) in pairs {
            credentials.insert(key, value);
        }
        credentials
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        let key = key.into();
        let value = value.into();
        if let Some(entry) = self.entries.iter_mut().find(|(name, _)| *name == key) {
            entry.1 = value;
        } else {
            self.entries.push((key, value));
        }
    }

    #[must_use]
    pub fn with(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.insert(key, value);
        self
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    /// First non-empty value among `names` (`firstCredential`, `ApiConsumer.ts:331-339`).
    #[must_use]
    pub fn first(&self, names: &[&str]) -> Option<&str> {
        names
            .iter()
            .find_map(|name| self.get(name).filter(|value| !value.is_empty()))
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(key, _)| key.as_str())
    }
}

impl fmt::Debug for GatewayCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayCredentials")
            .field("keys", &self.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl<K: Into<String>, V: Into<String>> FromIterator<(K, V)> for GatewayCredentials {
    fn from_iter<T: IntoIterator<Item = (K, V)>>(iter: T) -> Self {
        Self::from_pairs(iter)
    }
}

/// A refused authentication configuration or missing credential.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    #[error("API_KEY credential is missing")]
    ApiKeyMissing,
    #[error("Permanent token credential is missing")]
    PermanentTokenMissing,
    #[error("Basic authentication credentials are missing")]
    BasicCredentialsMissing,
    #[error("Request signature secret is missing")]
    SignatureSecretMissing,
    #[error("Authentication method {method} requires a token endpoint")]
    TokenEndpointRequired { method: &'static str },
    #[error("Username and password credentials are missing")]
    UsernamePasswordMissing,
    #[error("Refresh token credential is missing")]
    RefreshTokenMissing,
    #[error("Token endpoint response does not contain an access token")]
    TokenMissingInResponse,
    #[error("Mutual TLS certificate and private key are missing")]
    MutualTlsMaterialMissing,
    #[error("API_KEY body authentication cannot add a field to a {kind} body; use a header or query parameter")]
    BodyPlacementUnsupported { kind: &'static str },
    #[error("REQUEST_SIGNATURE cannot sign a {kind} body; send a pre-serialized payload or use a header-based signature")]
    SignatureBodyUnsupported { kind: &'static str },
    #[error("Unsupported gateway authentication method '{0}'")]
    UnknownMethod(String),
    #[error("Invalid gateway authentication configuration: {0}")]
    InvalidConfig(String),
}

impl AuthError {
    /// Stable API code. The TS consumer throws plain `Error`s for these paths (no `code` field);
    /// the `API_*` names are the Rust identifiers a caller can map to `STEP_REQUEST_INVALID`.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::ApiKeyMissing => "API_KEY_CREDENTIAL_MISSING",
            Self::PermanentTokenMissing => "API_PERMANENT_TOKEN_MISSING",
            Self::BasicCredentialsMissing => "API_BASIC_CREDENTIALS_MISSING",
            Self::SignatureSecretMissing => "API_SIGNATURE_SECRET_MISSING",
            Self::TokenEndpointRequired { .. } => "API_TOKEN_ENDPOINT_REQUIRED",
            Self::UsernamePasswordMissing => "API_USERNAME_PASSWORD_MISSING",
            Self::RefreshTokenMissing => "API_REFRESH_TOKEN_MISSING",
            Self::TokenMissingInResponse => "API_TOKEN_MISSING_IN_RESPONSE",
            Self::MutualTlsMaterialMissing => "API_MUTUAL_TLS_MATERIAL_MISSING",
            Self::BodyPlacementUnsupported { .. } => "API_BODY_PLACEMENT_UNSUPPORTED",
            Self::SignatureBodyUnsupported { .. } => "API_SIGNATURE_BODY_UNSUPPORTED",
            Self::UnknownMethod(_) => "API_AUTH_METHOD_UNKNOWN",
            Self::InvalidConfig(_) => "API_AUTH_CONFIG_INVALID",
        }
    }
}

/// The authentication configuration of one gateway credential set.
///
/// Field names match `GatewayAuthConfig`; `client_id`/`client_secret` are *credential keys* (TS
/// looks them up in the credential map), not literals. The canonicalisation fields are a Rust
/// extension for gateways whose profile signs something other than `"{timestamp}.{body}"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayAuthConfig {
    pub method: ApiConsumerAuth,
    pub placement: AuthPlacement,
    pub header_name: Option<String>,
    pub query_name: Option<String>,
    pub body_name: Option<String>,
    pub token_endpoint: Option<String>,
    pub refresh_url: Option<String>,
    pub refresh_period_ms: Option<u64>,
    pub access_token_selector: Option<String>,
    pub refresh_token_selector: Option<String>,
    pub new_refresh_token_selector: Option<String>,
    pub expires_in_selector: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub scope: Option<String>,
    pub username_field: Option<String>,
    pub password_field: Option<String>,
    pub refresh_token_field: Option<String>,
    pub signature_header: Option<String>,
    pub timestamp_header: Option<String>,
    pub signature_algorithm: SignatureAlgorithm,
    pub canonicalization_mode: Option<CanonicalizationMode>,
    pub template_string: Option<String>,
    pub included_fields: Option<Vec<String>>,
    pub excluded_fields: Option<Vec<String>>,
    pub value_separator: Option<String>,
}

impl GatewayAuthConfig {
    #[must_use]
    pub fn new(method: ApiConsumerAuth) -> Self {
        Self {
            method,
            placement: method.placement(),
            header_name: None,
            query_name: None,
            body_name: None,
            token_endpoint: None,
            refresh_url: None,
            refresh_period_ms: None,
            access_token_selector: None,
            refresh_token_selector: None,
            new_refresh_token_selector: None,
            expires_in_selector: None,
            client_id: None,
            client_secret: None,
            scope: None,
            username_field: None,
            password_field: None,
            refresh_token_field: None,
            signature_header: None,
            timestamp_header: None,
            signature_algorithm: SignatureAlgorithm::HmacSha256,
            canonicalization_mode: None,
            template_string: None,
            included_fields: None,
            excluded_fields: None,
            value_separator: None,
        }
    }

    #[must_use]
    pub fn none() -> Self {
        Self::new(ApiConsumerAuth::None)
    }

    /// Parse a stored `credential_sets.auth_config_json` object.
    ///
    /// Unknown keys are ignored (forward compatibility); a declared but invalid enum value is a
    /// configuration error, never a silent fallback, so a typo cannot downgrade authentication.
    pub fn from_json(value: &Value) -> Result<Self, AuthError> {
        let object = value
            .as_object()
            .ok_or_else(|| AuthError::InvalidConfig("auth config must be an object".to_owned()))?;
        let method_raw = object
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| AuthError::InvalidConfig("auth.method is required".to_owned()))?;
        let method = ApiConsumerAuth::parse(method_raw)
            .ok_or_else(|| AuthError::UnknownMethod(method_raw.to_owned()))?;
        let placement = match object.get("apply").and_then(Value::as_str) {
            Some(raw) => AuthPlacement::parse(raw).ok_or_else(|| {
                AuthError::InvalidConfig(format!("unsupported auth.apply '{raw}'"))
            })?,
            None => method.placement(),
        };
        let signature_algorithm = match object.get("signature_algorithm").and_then(Value::as_str) {
            Some(raw) => SignatureAlgorithm::parse(raw).ok_or_else(|| {
                AuthError::InvalidConfig(format!("unsupported signature_algorithm '{raw}'"))
            })?,
            None => SignatureAlgorithm::HmacSha256,
        };
        let canonicalization_mode =
            match object.get("canonicalization_mode").and_then(Value::as_str) {
                Some(raw) => Some(CanonicalizationMode::parse(raw).ok_or_else(|| {
                    AuthError::InvalidConfig(format!("unsupported canonicalization_mode '{raw}'"))
                })?),
                None => None,
            };
        Ok(Self {
            method: method.with_placement(placement),
            placement,
            header_name: string_field(object, "header_name"),
            query_name: string_field(object, "query_name"),
            body_name: string_field(object, "body_name"),
            token_endpoint: string_field(object, "token_endpoint"),
            refresh_url: string_field(object, "refresh_url"),
            refresh_period_ms: object.get("refresh_period_ms").and_then(Value::as_u64),
            access_token_selector: string_field(object, "access_token_selector"),
            refresh_token_selector: string_field(object, "refresh_token_selector"),
            new_refresh_token_selector: string_field(object, "new_refresh_token_selector"),
            expires_in_selector: string_field(object, "expires_in_selector"),
            client_id: string_field(object, "client_id"),
            client_secret: string_field(object, "client_secret"),
            scope: string_field(object, "scope"),
            username_field: string_field(object, "username_field"),
            password_field: string_field(object, "password_field"),
            refresh_token_field: string_field(object, "refresh_token_field"),
            signature_header: string_field(object, "signature_header"),
            timestamp_header: string_field(object, "timestamp_header"),
            signature_algorithm,
            canonicalization_mode,
            template_string: string_field(object, "template_string"),
            included_fields: list_field(object, "included_fields"),
            excluded_fields: list_field(object, "excluded_fields"),
            value_separator: string_field(object, "value_separator"),
        })
    }

    /// The header that carries the credential (`Authorization`, or `X-API-KEY` for `API_KEY`).
    ///
    /// `default_header_name` in [`ApiConsumerAuth`] returns the *signature* header for
    /// `REQUEST_SIGNATURE`; that method sets a signature header and never an `Authorization`.
    #[must_use]
    pub fn header_name(&self) -> &str {
        match self.header_name.as_deref() {
            Some(name) => name,
            None => match self.method {
                ApiConsumerAuth::ApiKey { .. } => DEFAULT_API_KEY_HEADER,
                _ => "Authorization",
            },
        }
    }

    #[must_use]
    pub fn query_name(&self) -> &str {
        self.query_name.as_deref().unwrap_or(DEFAULT_QUERY_NAME)
    }

    #[must_use]
    pub fn body_name(&self) -> &str {
        self.body_name.as_deref().unwrap_or(DEFAULT_BODY_NAME)
    }

    #[must_use]
    pub fn timestamp_header(&self) -> &str {
        self.timestamp_header
            .as_deref()
            .unwrap_or(DEFAULT_TIMESTAMP_HEADER)
    }

    #[must_use]
    pub fn signature_header(&self) -> &str {
        self.signature_header
            .as_deref()
            .unwrap_or(DEFAULT_SIGNATURE_HEADER)
    }

    /// Default `API_KEY` header (`X-API-KEY`).
    #[must_use]
    pub fn default_api_key_header(&self) -> &str {
        DEFAULT_API_KEY_HEADER
    }
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
}

fn list_field(object: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    object.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

/// Reject CR, LF or NUL in a header name/value or a query value.
///
/// Port of `assertNoControlCharacters` (`compileUrl.ts:64-68`), code `HEADER_INJECTION_BLOCKED`.
pub fn assert_no_control_characters(value: &str, label: &'static str) -> Result<(), AuthError> {
    if value.contains(['\r', '\n', '\0']) {
        return Err(AuthError::InvalidConfig(format!(
            "CR, LF, or NUL is forbidden in {label}"
        )));
    }
    Ok(())
}

/// Apply the header, query and signature parts of the authentication.
///
/// `access_token` is the cached/fetched token for the four token methods. `api_key` body placement
/// is applied *before* serialization by [`place_body_api_key`].
pub fn apply_auth(
    config: &GatewayAuthConfig,
    credentials: &GatewayCredentials,
    access_token: Option<&str>,
    now_seconds: i64,
    headers: &mut HeaderMap,
    query: &mut Vec<(String, String)>,
    body: &PreparedBody,
) -> Result<(), AuthError> {
    match config.method {
        ApiConsumerAuth::None => Ok(()),
        ApiConsumerAuth::ApiKey { .. } => {
            let value = credentials
                .first(&API_KEY_NAMES)
                .ok_or(AuthError::ApiKeyMissing)?;
            match config.placement {
                AuthPlacement::Header => set_config_header(headers, config.header_name(), value),
                AuthPlacement::Query => {
                    assert_no_control_characters(value, "query value")?;
                    query.push((config.query_name().to_owned(), value.to_owned()));
                    Ok(())
                }
                // Already applied to the structured body before serialization.
                AuthPlacement::Body => Ok(()),
            }
        }
        ApiConsumerAuth::PermanentToken => {
            let token = credentials
                .first(&["token", "accessToken", "access_token", "permanentToken"])
                .ok_or(AuthError::PermanentTokenMissing)?;
            set_config_header(headers, config.header_name(), &format!("Bearer {token}"))
        }
        ApiConsumerAuth::Basic => {
            let username = credentials
                .first(&["username", "user"])
                .ok_or(AuthError::BasicCredentialsMissing)?;
            let password = credentials
                .get("password")
                .or_else(|| credentials.get("pass"))
                .ok_or(AuthError::BasicCredentialsMissing)?;
            set_config_header(
                headers,
                config.header_name(),
                &format!("Basic {}", base64_encode(&format!("{username}:{password}"))),
            )
        }
        ApiConsumerAuth::RequestSignature { .. } => {
            let secret = credentials
                .first(&["secret", "signingSecret", "signatureSecret", "apiSecret"])
                .ok_or(AuthError::SignatureSecretMissing)?;
            if body.kind == crate::body::BodyKind::Multipart {
                // TS refuses a FormData body instead of signing "{}".
                return Err(AuthError::SignatureBodyUnsupported {
                    kind: body.kind.as_str(),
                });
            }
            let canonical = signed_payload(config, body, now_seconds)?;
            let signature = match config.canonicalization_mode {
                // The default mode is that same string; signing it directly is identical.
                None | Some(CanonicalizationMode::TimestampDotRawBody) => sign_request(
                    secret,
                    now_seconds,
                    &body.payload_text(),
                    config.signature_algorithm,
                ),
                Some(_) => sign_payload(secret, &canonical, config.signature_algorithm),
            };
            set_config_header(headers, config.timestamp_header(), &now_seconds.to_string())?;
            set_config_header(headers, config.signature_header(), &signature)?;
            if let Some(api_key) = credentials.first(&["apiKey", "api_key"]) {
                set_config_header(headers, DEFAULT_API_KEY_HEADER, api_key)?;
            }
            Ok(())
        }
        ApiConsumerAuth::MutualTls => Ok(()),
        ApiConsumerAuth::TokenEndpoint
        | ApiConsumerAuth::RefreshToken
        | ApiConsumerAuth::UsernamePassword
        | ApiConsumerAuth::OAuth2ClientCredentials => match access_token {
            Some(token) => {
                set_config_header(headers, config.header_name(), &format!("Bearer {token}"))
            }
            None => Ok(()),
        },
    }
}

/// Apply `API_KEY` with `apply: BODY` to the structured body.
///
/// TS serialises first and then throws for every body shape
/// (`ApiConsumer.ts:657-668`), so a body placement can never work there. Rust injects the field
/// into the structured JSON/form body before serialization (recorded as a deviation) and refuses
/// every body whose bytes are already final.
pub fn place_body_api_key(
    config: &GatewayAuthConfig,
    credentials: &GatewayCredentials,
    body: &mut crate::body::RequestBody,
) -> Result<(), AuthError> {
    if !matches!(config.method, ApiConsumerAuth::ApiKey { .. })
        || config.placement != AuthPlacement::Body
    {
        return Ok(());
    }
    let value = credentials
        .first(&API_KEY_NAMES)
        .ok_or(AuthError::ApiKeyMissing)?;
    let name = config.body_name().to_owned();
    use crate::body::RequestBody;
    match body {
        RequestBody::Json(Value::Object(map)) => {
            map.insert(name, Value::String(value.to_owned()));
            Ok(())
        }
        RequestBody::Form(fields) => {
            fields.push((name, value.to_owned()));
            Ok(())
        }
        RequestBody::None => Err(AuthError::BodyPlacementUnsupported { kind: "empty" }),
        RequestBody::Json(_) => Err(AuthError::BodyPlacementUnsupported { kind: "JSON array" }),
        RequestBody::Multipart(_) => Err(AuthError::BodyPlacementUnsupported { kind: "multipart" }),
        RequestBody::Bytes { .. } => Err(AuthError::BodyPlacementUnsupported { kind: "binary" }),
        RequestBody::Xml(_) => Err(AuthError::BodyPlacementUnsupported { kind: "XML" }),
        RequestBody::Text(_) => Err(AuthError::BodyPlacementUnsupported { kind: "text" }),
    }
}

fn signed_payload(
    config: &GatewayAuthConfig,
    body: &PreparedBody,
    timestamp_seconds: i64,
) -> Result<String, AuthError> {
    let mode = config
        .canonicalization_mode
        .unwrap_or(CanonicalizationMode::TimestampDotRawBody);
    let timestamp = timestamp_seconds.to_string();
    let raw = body.payload_text();
    match mode {
        CanonicalizationMode::TimestampDotRawBody => Ok(format!("{timestamp}.{raw}")),
        CanonicalizationMode::RawBody | CanonicalizationMode::MypayRawBody => Ok(raw),
        CanonicalizationMode::SortedKeyValueAmp
        | CanonicalizationMode::MoamalatSecureHash
        | CanonicalizationMode::SortedValuesHash
        | CanonicalizationMode::PlutuCallbackHash
        | CanonicalizationMode::JsonCanonical
        | CanonicalizationMode::TemplateString
        | CanonicalizationMode::DpayWebhookVerify => {
            if !body.kind.is_json_object() {
                return Err(AuthError::SignatureBodyUnsupported {
                    kind: body.kind.as_str(),
                });
            }
            let parsed: Value =
                serde_json::from_str(&raw).map_err(|_| AuthError::SignatureBodyUnsupported {
                    kind: body.kind.as_str(),
                })?;
            let fields = parsed.as_object().cloned().unwrap_or_default();
            let input = CanonicalizationInput {
                fields,
                raw_body: Some(raw.into_bytes()),
                timestamp: Some(timestamp),
                included_fields: config.included_fields.clone(),
                excluded_fields: config.excluded_fields.clone(),
                template_string: config.template_string.clone(),
                value_separator: config.value_separator.clone(),
            };
            canonicalize(mode, &input).map_err(canonical_error)
        }
    }
}

fn canonical_error(error: CanonicalError) -> AuthError {
    match error {
        CanonicalError::MissingTemplate => {
            AuthError::InvalidConfig("TEMPLATE_STRING requires template_string".to_owned())
        }
        other => AuthError::InvalidConfig(other.to_string()),
    }
}

fn set_config_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), AuthError> {
    assert_no_control_characters(name, "header name")?;
    assert_no_control_characters(value, "header")?;
    let name = HeaderName::from_bytes(name.trim().as_bytes())
        .map_err(|_| AuthError::InvalidConfig(format!("invalid header name '{name}'")))?;
    let value = HeaderValue::from_str(value)
        .map_err(|_| AuthError::InvalidConfig(format!("invalid value for header '{name}'")))?;
    headers.insert(name, value);
    Ok(())
}

fn base64_encode(value: &str) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    STANDARD.encode(value.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::RequestBody;

    fn credentials() -> GatewayCredentials {
        GatewayCredentials::from_pairs([
            ("apiKey", "key-123"),
            ("token", "tok-1"),
            ("username", "user"),
            ("password", "pass"),
            ("secret", "signing-secret"),
        ])
    }

    fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .expect(name)
    }

    #[test]
    fn credential_lookup_matches_the_ts_order_and_skips_empty_values() {
        let credentials = GatewayCredentials::from_pairs([
            ("apiKey", ""),
            ("api_key", "second"),
            ("key", "third"),
            ("certificate", "cert-pem"),
            ("privateKey", "key-pem"),
        ]);
        assert_eq!(credentials.first(&API_KEY_NAMES), Some("second"));
        assert_eq!(credentials.first(&["missing", "key"]), Some("third"));
        assert_eq!(credentials.len(), 5);
        assert_eq!(credentials.keys().count(), 5);
        assert!(!credentials.is_empty());
        assert_eq!(TLS_CERTIFICATE_NAMES.len(), 3);
        assert_eq!(TLS_PRIVATE_KEY_NAMES.len(), 3);
        assert_eq!(TLS_CA_NAMES.len(), 3);

        // A later duplicate replaces the earlier value.
        let replaced = GatewayCredentials::from_pairs([("apiKey", "one"), ("apiKey", "two")]);
        assert_eq!(replaced.get("apiKey"), Some("two"));
        assert_eq!(replaced.len(), 1);
    }

    #[test]
    fn debug_never_prints_a_credential_value() {
        let rendered = format!("{:?}", credentials());
        assert!(!rendered.contains("key-123"));
        assert!(!rendered.contains("tok-1"));
        assert!(!rendered.contains("signing-secret"));
        assert!(rendered.contains("apiKey"));
    }

    #[test]
    fn api_key_goes_to_the_header_query_or_body() {
        let mut headers = HeaderMap::new();
        let mut query = Vec::new();
        let body = RequestBody::None.prepare().expect("none");
        let config = GatewayAuthConfig::new(ApiConsumerAuth::parse("API_KEY").expect("api key"));
        apply_auth(
            &config,
            &credentials(),
            None,
            0,
            &mut headers,
            &mut query,
            &body,
        )
        .expect("header");
        assert_eq!(header(&headers, "x-api-key"), "key-123");
        assert!(query.is_empty());

        let query_config = config.clone().with_query();
        let mut headers = HeaderMap::new();
        let mut query = Vec::new();
        apply_auth(
            &query_config,
            &credentials(),
            None,
            0,
            &mut headers,
            &mut query,
            &body,
        )
        .expect("query");
        assert!(headers.is_empty());
        assert_eq!(query, vec![("api_key".to_owned(), "key-123".to_owned())]);
        assert_eq!(config.default_api_key_header(), "X-API-KEY");
    }

    #[test]
    fn api_key_body_placement_edits_a_structured_body() {
        let config =
            GatewayAuthConfig::new(ApiConsumerAuth::parse("API_KEY").expect("api key")).with_body();
        let mut json = RequestBody::Json(serde_json::json!({ "amount": "1.00" }));
        place_body_api_key(&config, &credentials(), &mut json).expect("json");
        assert_eq!(
            json,
            RequestBody::Json(serde_json::json!({ "amount": "1.00", "api_key": "key-123" }))
        );

        let mut form = RequestBody::form([("amount", "1.00")]);
        place_body_api_key(&config, &credentials(), &mut form).expect("form");
        assert_eq!(
            form,
            RequestBody::form([("amount", "1.00"), ("api_key", "key-123")])
        );

        let mut multipart =
            RequestBody::Multipart(crate::body::MultipartBody::new().field("a", "b"));
        assert_eq!(
            place_body_api_key(&config, &credentials(), &mut multipart).expect_err("multipart"),
            AuthError::BodyPlacementUnsupported { kind: "multipart" }
        );

        let mut array = RequestBody::Json(serde_json::json!([1, 2]));
        assert_eq!(
            place_body_api_key(&config, &credentials(), &mut array).expect_err("array"),
            AuthError::BodyPlacementUnsupported { kind: "JSON array" }
        );

        // A header placement never touches the body.
        let header_config = GatewayAuthConfig::new(ApiConsumerAuth::parse("API_KEY").expect("key"));
        let mut untouched = RequestBody::Json(serde_json::json!({}));
        place_body_api_key(&header_config, &credentials(), &mut untouched).expect("header");
        assert_eq!(untouched, RequestBody::Json(serde_json::json!({})));
    }

    #[test]
    fn permanent_token_and_basic_and_bearer_headers() {
        let mut headers = HeaderMap::new();
        let body = PreparedBody::empty();
        apply_auth(
            &GatewayAuthConfig::new(ApiConsumerAuth::PermanentToken),
            &credentials(),
            None,
            0,
            &mut headers,
            &mut Vec::new(),
            &body,
        )
        .expect("token");
        assert_eq!(header(&headers, "authorization"), "Bearer tok-1");

        let mut headers = HeaderMap::new();
        apply_auth(
            &GatewayAuthConfig::new(ApiConsumerAuth::Basic),
            &credentials(),
            None,
            0,
            &mut headers,
            &mut Vec::new(),
            &body,
        )
        .expect("basic");
        assert_eq!(
            header(&headers, "authorization"),
            format!("Basic {}", base64_encode("user:pass"))
        );

        // Token methods use the fetched token, never the credentials.
        let mut headers = HeaderMap::new();
        apply_auth(
            &GatewayAuthConfig::new(ApiConsumerAuth::OAuth2ClientCredentials),
            &GatewayCredentials::new(),
            Some("access-1"),
            0,
            &mut headers,
            &mut Vec::new(),
            &body,
        )
        .expect("bearer");
        assert_eq!(header(&headers, "authorization"), "Bearer access-1");

        // NONE and MUTUAL_TLS add nothing here.
        for method in [ApiConsumerAuth::None, ApiConsumerAuth::MutualTls] {
            let mut headers = HeaderMap::new();
            apply_auth(
                &GatewayAuthConfig::new(method),
                &credentials(),
                Some("ignored"),
                0,
                &mut headers,
                &mut Vec::new(),
                &body,
            )
            .expect("no header");
            assert!(headers.is_empty(), "{method:?}");
        }
    }

    #[test]
    fn a_missing_credential_is_a_typed_api_error() {
        let body = PreparedBody::empty();
        let cases = [
            (
                ApiConsumerAuth::ApiKey {
                    placement: AuthPlacement::Header,
                },
                AuthError::ApiKeyMissing,
            ),
            (
                ApiConsumerAuth::PermanentToken,
                AuthError::PermanentTokenMissing,
            ),
            (ApiConsumerAuth::Basic, AuthError::BasicCredentialsMissing),
            (
                ApiConsumerAuth::RequestSignature {
                    algorithm: SignatureAlgorithm::HmacSha256,
                },
                AuthError::SignatureSecretMissing,
            ),
        ];
        for (method, expected) in cases {
            let mut headers = HeaderMap::new();
            let error = apply_auth(
                &GatewayAuthConfig::new(method),
                &GatewayCredentials::new(),
                None,
                0,
                &mut headers,
                &mut Vec::new(),
                &body,
            )
            .expect_err("missing");
            assert_eq!(error, expected);
            assert!(error.code().starts_with("API_"));
            assert!(!error.to_string().is_empty());
        }
    }

    #[test]
    fn the_signature_covers_the_transmitted_body_and_timestamp() {
        let config = GatewayAuthConfig::new(ApiConsumerAuth::RequestSignature {
            algorithm: SignatureAlgorithm::HmacSha256,
        })
        .with_signature_header("X-Sig")
        .with_timestamp_header("X-Ts");
        let body = RequestBody::Json(serde_json::json!({ "amount": "1.00" }))
            .prepare()
            .expect("json");
        let mut headers = HeaderMap::new();
        apply_auth(
            &config,
            &credentials(),
            None,
            1_700_000_000,
            &mut headers,
            &mut Vec::new(),
            &body,
        )
        .expect("signature");
        assert_eq!(header(&headers, "x-ts"), "1700000000");
        let expected = crate::auth::sign_request(
            "signing-secret",
            1_700_000_000,
            &body.payload_text(),
            config.signature_algorithm,
        );
        assert_eq!(header(&headers, "x-sig"), expected);
        // TS forwards the api key beside the signature when the credential exists.
        assert_eq!(header(&headers, "x-api-key"), "key-123");

        let multipart = RequestBody::Multipart(crate::body::MultipartBody::new().field("a", "b"))
            .prepare()
            .expect("multipart");
        let mut headers = HeaderMap::new();
        assert_eq!(
            apply_auth(
                &config,
                &credentials(),
                None,
                0,
                &mut headers,
                &mut Vec::new(),
                &multipart
            )
            .expect_err("multipart"),
            AuthError::SignatureBodyUnsupported { kind: "multipart" }
        );
    }

    #[test]
    fn a_canonicalisation_mode_signs_the_canonical_string() {
        let mut config = GatewayAuthConfig::new(ApiConsumerAuth::RequestSignature {
            algorithm: SignatureAlgorithm::HmacSha256,
        });
        config.canonicalization_mode = Some(CanonicalizationMode::SortedKeyValueAmp);
        let body = RequestBody::Json(serde_json::json!({ "b": "2", "a": "1" }))
            .prepare()
            .expect("json");
        let mut headers = HeaderMap::new();
        apply_auth(
            &config,
            &credentials(),
            None,
            1_700_000_000,
            &mut headers,
            &mut Vec::new(),
            &body,
        )
        .expect("canonical signature");
        let canonical =
            crate::auth::sign_payload("signing-secret", "a=1&b=2", SignatureAlgorithm::HmacSha256);
        assert_eq!(header(&headers, "x-signature"), canonical);
        assert_eq!(header(&headers, "x-timestamp"), "1700000000");
    }

    #[test]
    fn header_injection_is_rejected() {
        let error = assert_no_control_characters("value\r\nx-evil: 1", "header").expect_err("crlf");
        assert_eq!(error.code(), "API_AUTH_CONFIG_INVALID");
        assert!(error.to_string().contains("CR, LF, or NUL"));

        let config = GatewayAuthConfig::new(ApiConsumerAuth::PermanentToken);
        let mut headers = HeaderMap::new();
        let error = apply_auth(
            &config,
            &GatewayCredentials::new().with("token", "abc\r\nx-evil: 1"),
            None,
            0,
            &mut headers,
            &mut Vec::new(),
            &PreparedBody::empty(),
        )
        .expect_err("injection");
        assert_eq!(
            error,
            AuthError::InvalidConfig("CR, LF, or NUL is forbidden in header".to_owned())
        );
    }

    #[test]
    fn config_parsing_defaults_and_rejects_typos() {
        let parsed = GatewayAuthConfig::from_json(&serde_json::json!({
            "method": "REQUEST_SIGNATURE",
            "apply": "HEADER",
            "signature_header": "X-Sig",
            "timestamp_header": "X-Ts",
            "signature_algorithm": "HMAC_SHA512",
            "canonicalization_mode": "TIMESTAMP_DOT_RAW_BODY",
            "refresh_period_ms": 300000,
            "included_fields": ["a", 2, "b"]
        }))
        .expect("config");
        assert_eq!(
            parsed.method,
            ApiConsumerAuth::RequestSignature {
                algorithm: SignatureAlgorithm::HmacSha256
            }
        );
        assert_eq!(parsed.signature_algorithm, SignatureAlgorithm::HmacSha512);
        assert_eq!(parsed.signature_header(), "X-Sig");
        assert_eq!(parsed.timestamp_header(), "X-Ts");
        assert_eq!(
            parsed.canonicalization_mode,
            Some(CanonicalizationMode::TimestampDotRawBody)
        );
        assert_eq!(parsed.refresh_period_ms, Some(300_000));
        assert_eq!(
            parsed.included_fields,
            Some(vec!["a".to_owned(), "b".to_owned()])
        );

        let api_key = GatewayAuthConfig::from_json(&serde_json::json!({
            "method": "API_KEY",
            "apply": "QUERY"
        }))
        .expect("api key");
        assert_eq!(api_key.placement, AuthPlacement::Query);

        assert!(matches!(
            GatewayAuthConfig::from_json(&serde_json::json!({ "method": "api_key" }))
                .expect_err("case"),
            AuthError::UnknownMethod(_)
        ));
        assert!(matches!(
            GatewayAuthConfig::from_json(
                &serde_json::json!({ "method": "API_KEY", "apply": "COOKIE" })
            )
            .expect_err("placement"),
            AuthError::InvalidConfig(_)
        ));
        assert!(matches!(
            GatewayAuthConfig::from_json(&serde_json::json!({ "method": "REQUEST_SIGNATURE", "signature_algorithm": "HMAC_MD5" }))
                .expect_err("algorithm"),
            AuthError::InvalidConfig(_)
        ));
        assert!(matches!(
            GatewayAuthConfig::from_json(&serde_json::json!([])).expect_err("not object"),
            AuthError::InvalidConfig(_)
        ));
        assert!(matches!(
            GatewayAuthConfig::from_json(&serde_json::json!({})).expect_err("no method"),
            AuthError::InvalidConfig(_)
        ));
    }

    #[test]
    fn default_names_match_the_ts_constants() {
        let config = GatewayAuthConfig::new(ApiConsumerAuth::RequestSignature {
            algorithm: SignatureAlgorithm::HmacSha256,
        });
        assert_eq!(config.timestamp_header(), DEFAULT_TIMESTAMP_HEADER);
        assert_eq!(config.signature_header(), DEFAULT_SIGNATURE_HEADER);
        assert_eq!(config.query_name(), DEFAULT_QUERY_NAME);
        assert_eq!(config.body_name(), DEFAULT_BODY_NAME);
        assert_eq!(config.header_name(), "Authorization");
        assert_eq!(GatewayAuthConfig::none().method, ApiConsumerAuth::None);
    }

    impl GatewayAuthConfig {
        fn with_query(mut self) -> Self {
            self.placement = AuthPlacement::Query;
            self
        }

        fn with_body(mut self) -> Self {
            self.placement = AuthPlacement::Body;
            self
        }

        fn with_signature_header(mut self, value: &str) -> Self {
            self.signature_header = Some(value.to_owned());
            self
        }

        fn with_timestamp_header(mut self, value: &str) -> Self {
            self.timestamp_header = Some(value.to_owned());
            self
        }
    }
}
