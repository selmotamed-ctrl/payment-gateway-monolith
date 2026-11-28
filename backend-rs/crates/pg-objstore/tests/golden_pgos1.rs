//! Interoperability with the real TS `pgos1` writer.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use pg_objstore::pgos1::{decrypt_pgos1, KekKeyring, ObjectCryptoMetadata, Pgos1Error};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const PGOS1: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden-vectors/pgos1.json"
));

#[derive(Deserialize)]
struct File {
    keyring: String,
    #[serde(rename = "activeKekVersion")]
    active_kek_version: u32,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    object_id: String,
    plaintext_base64: String,
    stream_base64: String,
    frame_lengths: Vec<u32>,
    metadata: serde_json::Value,
}

#[test]
fn opens_typescript_streams() {
    let file: File = serde_json::from_str(PGOS1).expect("pgos1 vectors");
    let keyring = KekKeyring::parse(&file.keyring, Some(file.active_kek_version)).expect("keyring");
    for case in &file.cases {
        let object_id = Uuid::parse_str(&case.object_id).expect("object id");
        let plaintext = STANDARD.decode(&case.plaintext_base64).expect("plaintext");
        let stream = STANDARD.decode(&case.stream_base64).expect("stream");
        let metadata: ObjectCryptoMetadata =
            serde_json::from_value(case.metadata.clone()).expect("metadata");
        assert_eq!(
            plaintext.len() as u64,
            metadata.plaintext_size,
            "{}",
            case.id
        );
        assert_eq!(
            hex::encode(Sha256::digest(&plaintext)),
            metadata.plaintext_sha256,
            "{}",
            case.id
        );
        assert_eq!(metadata.chunk_size, 4096);
        assert_eq!(
            case.frame_lengths.len() as u64,
            metadata.chunk_count,
            "{}",
            case.id
        );

        // Framing contract: u32be(plaintext_len) | ct | tag(16).
        assert_eq!(&stream[..5], b"pgos1");
        let mut offset = 5_usize;
        for (index, declared) in case.frame_lengths.iter().enumerate() {
            let len =
                u32::from_be_bytes(stream[offset..offset + 4].try_into().expect("length bytes"))
                    as usize;
            assert_eq!(len as u32, *declared, "{} frame {}", case.id, index);
            offset += 4 + len + 16;
            assert!(offset <= stream.len(), "{} frame {}", case.id, index);
        }
        assert_eq!(offset, stream.len(), "{}", case.id);
        assert_eq!(
            stream.len(),
            5 + 4 * case.frame_lengths.len() + plaintext.len() + 16 * case.frame_lengths.len(),
            "{}",
            case.id
        );

        assert_eq!(
            decrypt_pgos1(object_id, &stream, &keyring, &metadata).expect("decrypt"),
            plaintext,
            "{}",
            case.id
        );

        assert_eq!(
            decrypt_pgos1(Uuid::new_v4(), &stream, &keyring, &metadata).expect_err("aad"),
            Pgos1Error::Crypto
        );
    }
    assert_eq!(file.cases.len(), 5);
}
