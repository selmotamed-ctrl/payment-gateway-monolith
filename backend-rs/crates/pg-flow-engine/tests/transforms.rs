//! The transform DSL as the stored gateway flow JSON writes it.

use std::sync::Arc;

use pg_flow_engine::{
    decimal_string, FixedClock, SecretResolver, TransformContext, TransformPipe, TransformPipeline,
};
use serde_json::{json, Value};

fn pipeline() -> TransformPipeline {
    TransformPipeline::new(
        Arc::new(FixedClock::at(1_700_000_000_000)),
        Arc::new(pg_flow_engine::CounterRng::new(1)),
    )
}

fn context(values: &serde_json::Map<String, Value>) -> TransformContext<'_> {
    TransformContext::with_values(values)
}

fn apply(value: Value, pipes: &[TransformPipe]) -> Value {
    let values = serde_json::Map::new();
    pipeline()
        .apply(value, pipes, &context(&values))
        .expect("transform")
}

fn pipes_from_json(value: Value) -> Vec<TransformPipe> {
    serde_json::from_value(value).expect("pipes")
}

#[test]
fn the_stored_pipe_shape_deserialises_and_runs() {
    let pipes = pipes_from_json(json!([
        { "op": "scale", "args": [1000] },
        { "op": "to_int" },
        { "op": "to_string" }
    ]));
    assert_eq!(apply(json!("12.3456"), &pipes), json!("12345"));

    let pipes = pipes_from_json(json!([
        { "op": "format_decimal", "args": [2] }
    ]));
    assert_eq!(apply(json!("100"), &pipes), json!("100.00"));
}

#[test]
fn money_rounding_never_uses_a_float() {
    let cases = [
        ("1.005", "NEAREST", "1.01"),
        ("1.004", "NEAREST", "1"),
        ("1.001", "UP", "1.01"),
        ("1.009", "DOWN", "1"),
        ("-1.005", "NEAREST", "-1.01"),
        ("-1.005", "UP", "-1.01"),
    ];
    for (value, mode, expected) in cases {
        let pipes = vec![TransformPipe::round(mode, 2)];
        assert_eq!(
            apply(json!(value), &pipes),
            json!(expected),
            "{value} {mode}"
        );
    }
    let pipes = vec![TransformPipe::round("NONE", 2)];
    assert_eq!(apply(json!("1.005"), &pipes), json!("1.005"));
    // The exact decimal formatting helper keeps the requested scale.
    assert_eq!(decimal_string(dec("100"), 4), "100.0000");
}

#[test]
fn division_rounds_half_up_on_the_truncated_quotient() {
    let pipes = vec![TransformPipe::div_decimal("3", 4)];
    assert_eq!(apply(json!("10"), &pipes), json!("3.3333"));
    let pipes = vec![TransformPipe::div_decimal("8", 2)];
    assert_eq!(apply(json!("1"), &pipes), json!("0.13"));
    let pipes = vec![TransformPipe::div_decimal("0", 2)];
    let values = serde_json::Map::new();
    assert!(pipeline()
        .apply(json!("1"), &pipes, &context(&values))
        .is_err());
}

#[test]
fn strings_numbers_and_phone_numbers() {
    assert_eq!(
        apply(json!("  AbC  "), &[TransformPipe::no_args("trim")]),
        json!("AbC")
    );
    assert_eq!(
        apply(json!("AbC"), &[TransformPipe::no_args("lowercase")]),
        json!("abc")
    );
    assert_eq!(
        apply(
            json!("0912345678"),
            &[TransformPipe::phone_normalize("E164")]
        ),
        json!("+218912345678")
    );
    assert_eq!(
        apply(
            json!("+218912345678"),
            &[TransformPipe::phone_normalize("LOCAL_09")]
        ),
        json!("0912345678")
    );
    assert_eq!(
        apply(
            json!("+218912345678"),
            &[TransformPipe::phone_normalize("INTL_218")]
        ),
        json!("218912345678")
    );
    assert_eq!(
        apply(
            json!("١٢٣٤"),
            &[TransformPipe::no_args("arabic_digits_to_ascii")]
        ),
        json!("1234")
    );
    let error = pipeline()
        .apply(
            json!("12345"),
            &[TransformPipe::phone_normalize("LOCAL_09")],
            &context(&serde_json::Map::new()),
        )
        .expect_err("short phone");
    assert_eq!(error.code, "TRANSFORM_ERROR");
}

#[test]
fn json_object_helpers_keep_order_and_sort_with_js_semantics() {
    assert_eq!(
        apply(
            json!({"b": 2, "a": {"d": 4, "c": 3}}),
            &[TransformPipe::no_args("sort_keys")]
        ),
        json!({"a": {"c": 3, "d": 4}, "b": 2})
    );
    assert_eq!(
        apply(
            json!({"a": 1, "b": 2}),
            &[TransformPipe::no_args("values_only")]
        ),
        json!([1, 2])
    );
    assert_eq!(
        apply(
            json!({"b": "B", "a": "A"}),
            &[TransformPipe::new(
                "join_pairs",
                vec![json!("="), json!("&")]
            )]
        ),
        json!("a=A&b=B")
    );
    assert_eq!(
        apply(
            json!({"b": "B", "a": "A"}),
            &[TransformPipe::new(
                "join_pairs",
                vec![json!(":"), json!(";")]
            )]
        ),
        json!("a:A;b:B")
    );
}

#[test]
fn templates_read_the_customer_value_map() {
    let mut values = serde_json::Map::new();
    values.insert("reference".to_owned(), json!("ORD-1"));
    values.insert("amount".to_owned(), json!("100.00"));
    let result = pipeline()
        .apply(
            json!(null),
            &[TransformPipe::template("ref={reference}&amount={amount}")],
            &context(&values),
        )
        .expect("template");
    assert_eq!(result, json!("ref=ORD-1&amount=100.00"));
    let result = pipeline()
        .apply(
            json!("x"),
            &[TransformPipe::template("{{missing}}")],
            &context(&values),
        )
        .expect("template");
    assert_eq!(result, json!(""));
}

#[test]
fn dates_use_the_gateway_timezone() {
    let values = serde_json::Map::new();
    let formatted = pipeline()
        .apply(
            json!("2023-11-14T22:13:20Z"),
            &[TransformPipe::format_date("YYYYMMDDHHmm", "Africa/Tripoli")],
            &context(&values),
        )
        .expect("date");
    assert_eq!(formatted, json!("202311150013"));
    let millis = pipeline()
        .apply(
            json!(1_700_000_000_123_i64),
            &[TransformPipe::format_date("YYYY-MM-DDTHH:mm:ss.SSS", "UTC")],
            &context(&values),
        )
        .expect("date");
    assert_eq!(millis, json!("2023-11-14T22:13:20.123"));
}

#[test]
fn encodings_match_the_javascript_helpers() {
    assert_eq!(
        apply(json!("a b&c"), &[TransformPipe::no_args("url_encode")]),
        json!("a%20b%26c")
    );
    assert_eq!(
        apply(json!("a<b"), &[TransformPipe::no_args("xml_escape")]),
        json!("a&lt;b")
    );
    assert_eq!(
        apply(json!({"a": 1}), &[TransformPipe::no_args("json_encode")]),
        json!("{\"a\":1}")
    );
    assert_eq!(
        apply(json!("abc"), &[TransformPipe::no_args("base64_encode")]),
        json!("YWJj")
    );
    assert_eq!(
        apply(json!("abc"), &[TransformPipe::no_args("hex_upper")]),
        json!("616263")
    );
    assert_eq!(
        apply(json!("abc"), &[TransformPipe::no_args("sha256")]),
        json!("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    );
}

struct Secrets;

impl SecretResolver for Secrets {
    fn resolve_secret(&self, reference: &str) -> Result<Vec<u8>, String> {
        if reference == "CREDENTIAL.key" {
            Ok(b"secret".to_vec())
        } else {
            Err("missing".to_owned())
        }
    }
}

#[test]
fn hmac_and_prepend_read_the_secret_resolver() {
    let values = serde_json::Map::new();
    let secrets = Secrets;
    let context = TransformContext {
        template_values: &values,
        secret_resolver: Some(&secrets),
        hash_output_encoding: None,
    };
    let result = pipeline()
        .apply(
            json!("abc"),
            &[TransformPipe::new(
                "hmac_sha256",
                vec![json!("CREDENTIAL.key")],
            )],
            &context,
        )
        .expect("hmac");
    assert_eq!(
        result,
        json!(hex::encode(pg_crypto::hmac_sha256(b"secret", b"abc")))
    );
    let result = pipeline()
        .apply(
            json!("tail"),
            &[TransformPipe::new("prepend", vec![json!("CREDENTIAL.key")])],
            &context,
        )
        .expect("prepend");
    assert_eq!(result, json!("secrettail"));
}

#[test]
fn the_closed_library_rejects_unknown_or_broken_pipes() {
    let pipeline = pipeline();
    assert!(!pipeline
        .validate(&pipes_from_json(json!([{ "op": "not_real" }])))
        .is_empty());
    assert!(!pipeline
        .validate(&pipes_from_json(json!([{ "op": "scale", "args": [0] }])))
        .is_empty());
    assert!(!pipeline
        .validate(&pipes_from_json(
            json!([{ "op": "format_date", "args": ["YYYY", "Not/AZone"] }])
        ))
        .is_empty());
    // A monetary store refuses the float-producing operation.
    let pipes = pipes_from_json(json!([{ "op": "to_number" }]));
    assert!(pipeline.validate(&pipes).is_empty());
    assert!(pipeline
        .validate_for_store(&pipes, Some("SETTLED_AMOUNT"))
        .iter()
        .any(|error| error.op == "to_number"));
    assert!(pipeline
        .validate_for_store(&pipes, Some("PUBLIC"))
        .is_empty());
}

#[test]
fn to_number_is_available_only_for_non_money_values() {
    let values = serde_json::Map::new();
    let result = pipeline()
        .apply(
            json!("1.5"),
            &[TransformPipe::no_args("to_number")],
            &context(&values),
        )
        .expect("to_number");
    assert_eq!(result, json!(1.5));
    let result = pipeline()
        .apply(
            json!("abc"),
            &[TransformPipe::no_args("to_number")],
            &context(&values),
        )
        .expect("nan");
    assert_eq!(result, Value::Null);
}

fn dec(value: &str) -> rust_decimal::Decimal {
    value.parse().expect("decimal")
}
