//! JavaScript object-key ordering vectors.

use pg_types::json_order::{is_array_index, js_object_order, js_object_order_string};
use serde::Deserialize;
use serde_json::{Map, Value};

const ORDER: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden-vectors/js-key-order.json"
));

#[derive(Deserialize)]
struct File {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    insertion: Vec<(String, Value)>,
    object_keys: Vec<String>,
    stringified: String,
}

#[test]
fn key_order_matches_javascript() {
    let file: File = serde_json::from_str(ORDER).expect("order vectors");
    for case in file.cases {
        let mut map = Map::new();
        for (key, value) in case.insertion {
            map.insert(key, value);
        }
        let value = Value::Object(map);
        assert_eq!(
            js_object_order_string(&value),
            case.stringified,
            "{}",
            case.id
        );
        let ordered = js_object_order(&value);
        let keys: Vec<&str> = ordered
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        let expected: Vec<&str> = case.object_keys.iter().map(String::as_str).collect();
        assert_eq!(keys, expected, "{}", case.id);
    }
}

#[test]
fn array_index_boundaries() {
    assert!(is_array_index("0"));
    assert!(is_array_index("4294967294"));
    assert!(!is_array_index("4294967295"));
    assert!(!is_array_index("4294967296"));
    assert!(!is_array_index("01"));
    assert!(!is_array_index(" 1"));
    assert!(!is_array_index("1 "));
    assert!(!is_array_index("1.0"));
    assert!(!is_array_index("-1"));
}
