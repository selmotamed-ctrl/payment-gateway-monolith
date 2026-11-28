//! Settlement statements (CSV / JSON) and the dependency-free XLSX writer.
//!
//! TS: `api/portal/statements.ts` and `engine/statements/xlsx.ts`. The XLSX is a store-only ZIP with
//! the OOXML parts, byte-compatible in spirit (a single flat sheet).

#![forbid(unsafe_code)]

use serde_json::{json, Value};

use crate::chaos::Prng;
use crate::db::{list_transactions, now_iso, text, uuid_v7, Db, TransactionFilters};
use crate::error::{ApiError, ApiResult};

pub const SETTLED_STATUSES: [&str; 4] = ["PAID", "SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"];

#[derive(Debug, Clone)]
pub struct StatementLine {
    pub provider_reference: String,
    pub our_reference: String,
    pub amount: String,
    pub fee: String,
    pub currency: String,
    pub status: String,
    pub settled_at: String,
}

impl StatementLine {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "provider_reference": self.provider_reference,
            "our_reference": self.our_reference,
            "amount": self.amount,
            "fee": self.fee,
            "currency": self.currency,
            "status": self.status,
            "settled_at": self.settled_at,
        })
    }
}

fn lines_for(
    db: &Db,
    gateway_code: &str,
    from: &str,
    to: &str,
    statuses: &[&str],
) -> ApiResult<Vec<StatementLine>> {
    let (rows, _) = list_transactions(
        db,
        &TransactionFilters {
            gateway_code: Some(gateway_code.to_owned()),
            from: Some(from.to_owned()),
            to: Some(to.to_owned()),
            limit: Some(1000),
            ..TransactionFilters::default()
        },
    )?;
    Ok(rows
        .iter()
        .filter(|row| {
            row.get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| statuses.contains(&status))
        })
        .map(|row| {
            let normalized = row
                .get("normalized_amount_lyd")
                .and_then(Value::as_str)
                .unwrap_or("0.0000");
            StatementLine {
                provider_reference: row
                    .get("provider_reference")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                our_reference: row
                    .get("our_reference")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                amount: row
                    .get("settled_amount_lyd")
                    .and_then(Value::as_str)
                    .unwrap_or(normalized)
                    .to_owned(),
                fee: row
                    .get("gateway_fee_lyd")
                    .and_then(Value::as_str)
                    .unwrap_or("0.0000")
                    .to_owned(),
                currency: row
                    .get("currency")
                    .and_then(Value::as_str)
                    .unwrap_or("LYD")
                    .to_owned(),
                status: row
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                settled_at: row
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            }
        })
        .collect())
}

#[derive(Debug, Clone, Default)]
pub struct Anomalies {
    pub fee_variance_percent: f64,
    pub fee_variance_amount: f64,
    pub omit_one: bool,
    pub add_unrecorded: bool,
}

#[must_use]
pub fn apply_anomalies(
    lines: &[StatementLine],
    anomalies: &Anomalies,
    seed: &str,
) -> Vec<StatementLine> {
    let mut output = lines.to_vec();
    if anomalies.fee_variance_percent > 0.0 {
        let mut prng = Prng::new(seed);
        output = output
            .into_iter()
            .map(|mut line| {
                if prng.chance(anomalies.fee_variance_percent) {
                    let fee = crate::money::micros(&line.fee)
                        + crate::money::micros(&anomalies.fee_variance_amount.to_string());
                    line.fee = crate::money::lyd(fee);
                }
                line
            })
            .collect();
    }
    if anomalies.omit_one && !output.is_empty() {
        output.pop();
    }
    if anomalies.add_unrecorded {
        let stamp = chrono::Utc::now().timestamp_millis();
        output.push(StatementLine {
            provider_reference: format!("FK-UNRECORDED-{stamp}"),
            our_reference: format!("UNRECORDED-{stamp}"),
            amount: "10.0000".to_owned(),
            fee: "0.0000".to_owned(),
            currency: "LYD".to_owned(),
            status: "PAID".to_owned(),
            settled_at: now_iso(),
        });
    }
    output
}

#[must_use]
pub fn to_csv(lines: &[StatementLine]) -> String {
    let header = "provider_reference,our_reference,amount,fee,currency,status,settled_at";
    let body = lines
        .iter()
        .map(|line| {
            [
                line.provider_reference.as_str(),
                line.our_reference.as_str(),
                line.amount.as_str(),
                line.fee.as_str(),
                line.currency.as_str(),
                line.status.as_str(),
                line.settled_at.as_str(),
            ]
            .join(",")
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{header}\n{body}\n")
}

/// Gateway-side `/statement` endpoint body (settled only) in CSV or JSON.
pub fn gateway_statement(
    db: &Db,
    gateway_code: &str,
    from: Option<&str>,
    to: Option<&str>,
    format: &str,
) -> ApiResult<(String, String)> {
    let from = from.map_or_else(
        || {
            (chrono::Utc::now() - chrono::Duration::days(30))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        },
        str::to_owned,
    );
    let to = to.map_or_else(
        || chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        str::to_owned,
    );
    let lines = lines_for(
        db,
        gateway_code,
        &from,
        &to,
        &["PAID", "SUCCEEDED", "REFUNDED"],
    )?;
    if format == "json" {
        let body = json!({
            "gateway": gateway_code,
            "window_start": from,
            "window_end": to,
            "currency": "LYD",
            "lines": lines.iter().map(StatementLine::to_json).collect::<Vec<_>>(),
        });
        return Ok((
            "application/json; charset=utf-8".to_owned(),
            body.to_string(),
        ));
    }
    Ok(("text/csv".to_owned(), to_csv(&lines)))
}

#[derive(Debug)]
pub struct GeneratedStatement {
    pub id: String,
    pub gateway_code: String,
    pub from: String,
    pub to: String,
    pub lines: Vec<StatementLine>,
    pub format: String,
}

pub fn generate_statement(
    db: &Db,
    gateway_code: &str,
    from: Option<&str>,
    to: Option<&str>,
    format: &str,
    anomalies: &Anomalies,
) -> ApiResult<GeneratedStatement> {
    let from = from.map_or_else(
        || {
            (chrono::Utc::now() - chrono::Duration::days(30))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        },
        str::to_owned,
    );
    let to = to.map_or_else(
        || chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        str::to_owned,
    );
    let from_instant = chrono::DateTime::parse_from_rfc3339(&from)
        .map_err(|_| ApiError::new(400, "INVALID_WINDOW", "from must be an ISO instant"))?;
    let to_instant = chrono::DateTime::parse_from_rfc3339(&to)
        .map_err(|_| ApiError::new(400, "INVALID_WINDOW", "to must be an ISO instant"))?;
    if from_instant > to_instant {
        return Err(ApiError::new(
            400,
            "INVALID_WINDOW",
            "from must be before to",
        ));
    }
    let base = lines_for(db, gateway_code, &from, &to, &SETTLED_STATUSES)?;
    let lines = apply_anomalies(&base, anomalies, &format!("{gateway_code}:{from}:{to}"));
    let id = uuid_v7();
    db.execute(
        "INSERT INTO fake_statements (id, gateway_code, format, window_start, window_end, anomaly_json, row_count, created_at)
         VALUES (?,?,?,?,?,?,?,?)",
        vec![
            text(id.clone()),
            text(gateway_code),
            text(format),
            text(from.clone()),
            text(to.clone()),
            text(
                json!({
                    "feeVariancePercent": anomalies.fee_variance_percent,
                    "feeVarianceAmount": anomalies.fee_variance_amount,
                    "omitOne": anomalies.omit_one,
                    "addUnrecorded": anomalies.add_unrecorded,
                })
                .to_string(),
            ),
            crate::db::int(lines.len() as i64),
            text(now_iso()),
        ],
    )?;
    Ok(GeneratedStatement {
        id,
        gateway_code: gateway_code.to_owned(),
        from,
        to,
        lines,
        format: format.to_owned(),
    })
}

// ---------------------------------------------------------------------------------------------
// XLSX (store-only ZIP + OOXML)
// ---------------------------------------------------------------------------------------------

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

struct ZipEntry {
    name: String,
    data: Vec<u8>,
}

fn local_header(entry: &ZipEntry) -> Vec<u8> {
    let name = entry.name.as_bytes();
    let mut header = Vec::with_capacity(30 + name.len() + entry.data.len());
    push_u32(&mut header, 0x0403_4b50);
    push_u16(&mut header, 20);
    push_u16(&mut header, 0);
    push_u16(&mut header, 0);
    push_u16(&mut header, 0);
    push_u16(&mut header, 0);
    push_u32(&mut header, crc32(&entry.data));
    push_u32(&mut header, entry.data.len() as u32);
    push_u32(&mut header, entry.data.len() as u32);
    push_u16(&mut header, name.len() as u16);
    push_u16(&mut header, 0);
    header.extend_from_slice(name);
    header.extend_from_slice(&entry.data);
    header
}

fn central_header(entry: &ZipEntry, offset: u32) -> Vec<u8> {
    let name = entry.name.as_bytes();
    let mut header = Vec::with_capacity(46 + name.len());
    push_u32(&mut header, 0x0201_4b50);
    push_u16(&mut header, 20);
    push_u16(&mut header, 20);
    push_u16(&mut header, 0);
    push_u16(&mut header, 0);
    push_u16(&mut header, 0);
    push_u16(&mut header, 0);
    push_u32(&mut header, crc32(&entry.data));
    push_u32(&mut header, entry.data.len() as u32);
    push_u32(&mut header, entry.data.len() as u32);
    push_u16(&mut header, name.len() as u16);
    push_u16(&mut header, 0);
    push_u16(&mut header, 0);
    push_u16(&mut header, 0);
    push_u16(&mut header, 0);
    push_u32(&mut header, 0);
    push_u32(&mut header, offset);
    header.extend_from_slice(name);
    header
}

fn zip(entries: &[ZipEntry]) -> Vec<u8> {
    let mut locals = Vec::new();
    let mut centrals = Vec::new();
    let mut offset = 0u32;
    for entry in entries {
        let local = local_header(entry);
        centrals.push(central_header(entry, offset));
        offset = offset.saturating_add(local.len() as u32);
        locals.extend_from_slice(&local);
    }
    let central_directory: Vec<u8> = centrals.concat();
    let mut eocd = Vec::with_capacity(22);
    push_u32(&mut eocd, 0x0605_4b50);
    push_u16(&mut eocd, 0);
    push_u16(&mut eocd, 0);
    push_u16(&mut eocd, entries.len() as u16);
    push_u16(&mut eocd, entries.len() as u16);
    push_u32(&mut eocd, central_directory.len() as u32);
    push_u32(&mut eocd, offset);
    push_u16(&mut eocd, 0);
    let mut output = locals;
    output.extend_from_slice(&central_directory);
    output.extend_from_slice(&eocd);
    output
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn column_name(index: usize) -> String {
    let mut name = String::new();
    let mut current = index + 1;
    while current > 0 {
        let remainder = (current - 1) % 26;
        name.insert(0, char::from(b'A' + remainder as u8));
        current = (current - 1) / 26;
    }
    name
}

fn sheet_xml(rows: &[Vec<String>]) -> String {
    let body = rows
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            let cells = row
                .iter()
                .enumerate()
                .map(|(column_index, value)| {
                    let reference = format!("{}{}", column_name(column_index), row_index + 1);
                    format!(
                        "<c r=\"{reference}\" t=\"inlineStr\"><is><t>{}</t></is></c>",
                        escape_xml(value)
                    )
                })
                .collect::<Vec<_>>()
                .join("");
            format!("<row r=\"{}\">{cells}</row>", row_index + 1)
        })
        .collect::<Vec<_>>()
        .join("");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>{body}</sheetData></worksheet>"
    )
}

#[must_use]
pub fn build_xlsx(sheet_name: &str, rows: &[Vec<String>]) -> Vec<u8> {
    let entries = vec![
        ZipEntry {
            name: "[Content_Types].xml".to_owned(),
            data: b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\n<Default Extension=\"xml\" ContentType=\"application/xml\"/>\n<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\n<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>\n</Types>".to_vec(),
        },
        ZipEntry {
            name: "_rels/.rels".to_owned(),
            data: b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>\n</Relationships>".to_vec(),
        },
        ZipEntry {
            name: "xl/workbook.xml".to_owned(),
            data: format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">\n<sheets><sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>",
                escape_xml(&sheet_name.chars().take(31).collect::<String>())
            )
            .into_bytes(),
        },
        ZipEntry {
            name: "xl/_rels/workbook.xml.rels".to_owned(),
            data: b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>\n</Relationships>".to_vec(),
        },
        ZipEntry {
            name: "xl/worksheets/sheet1.xml".to_owned(),
            data: sheet_xml(rows).into_bytes(),
        },
    ];
    zip(&entries)
}

#[must_use]
pub fn statement_xlsx(gateway_code: &str, lines: &[StatementLine]) -> Vec<u8> {
    let mut rows = vec![vec![
        "provider_reference".to_owned(),
        "our_reference".to_owned(),
        "amount".to_owned(),
        "fee".to_owned(),
        "currency".to_owned(),
        "status".to_owned(),
        "settled_at".to_owned(),
    ]];
    rows.extend(lines.iter().map(|line| {
        vec![
            line.provider_reference.clone(),
            line.our_reference.clone(),
            line.amount.clone(),
            line.fee.clone(),
            line.currency.clone(),
            line.status.clone(),
            line.settled_at.clone(),
        ]
    }));
    build_xlsx(&format!("{gateway_code} settlement"), &rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{insert_transaction, Transaction};

    fn transaction(db: &Db, reference: &str, status: &str) -> Transaction {
        let now = now_iso();
        let row = Transaction {
            id: uuid_v7(),
            gateway_code: "edfali".to_owned(),
            rail_code: "edfali".to_owned(),
            env: "SANDBOX".to_owned(),
            our_reference: reference.to_owned(),
            provider_reference: format!("FK-{reference}"),
            network_reference: None,
            idempotency_key: None,
            requested_amount_wire: "10.00".to_owned(),
            normalized_amount_lyd: "10.0000".to_owned(),
            settled_amount_lyd: Some("10.0000".to_owned()),
            gateway_fee_lyd: "0.1000".to_owned(),
            currency: "LYD".to_owned(),
            collection_mode: "OTP_PULL".to_owned(),
            customer_identifier_masked: None,
            expected_otp: None,
            merchant_id: None,
            qr_payload: None,
            deep_link_url: None,
            redirect_url: None,
            account_id: None,
            held_amount_lyd: None,
            status: status.to_owned(),
            assigned_fail_phase: None,
            assigned_failure_mode: None,
            inquiry_override_status: None,
            return_url: None,
            cancel_url: None,
            webhook_url: None,
            is_seeded_historical: 0,
            created_at: now.clone(),
            updated_at: now,
        };
        insert_transaction(db, &row).expect("insert");
        row
    }

    #[test]
    fn csv_has_the_header_and_one_line_per_settlement() {
        let db = Db::memory().expect("db");
        transaction(&db, "STMT-1", "PAID");
        transaction(&db, "STMT-2", "AWAITING_ACTION");
        let (content_type, body) =
            gateway_statement(&db, "edfali", None, None, "csv").expect("stmt");
        assert_eq!(content_type, "text/csv");
        assert!(body.starts_with(
            "provider_reference,our_reference,amount,fee,currency,status,settled_at\nFK-STMT-1,STMT-1,10.0000,0.1000,LYD,PAID,"
        ));
        assert_eq!(body.lines().count(), 2);
    }

    #[test]
    fn anomalies_inject_variance_omission_and_unrecorded_lines() {
        let base = vec![StatementLine {
            provider_reference: "P".to_owned(),
            our_reference: "O".to_owned(),
            amount: "10.0000".to_owned(),
            fee: "0.0000".to_owned(),
            currency: "LYD".to_owned(),
            status: "PAID".to_owned(),
            settled_at: "2026-01-01T00:00:00.000Z".to_owned(),
        }];
        let with_all = apply_anomalies(
            &base,
            &Anomalies {
                fee_variance_percent: 100.0,
                fee_variance_amount: 0.15,
                omit_one: false,
                add_unrecorded: true,
            },
            "seed",
        );
        assert_eq!(with_all.len(), 2);
        assert_eq!(with_all[0].fee, "0.1500");
        assert!(with_all[1].our_reference.starts_with("UNRECORDED-"));
        let omitted = apply_anomalies(
            &base,
            &Anomalies {
                omit_one: true,
                ..Anomalies::default()
            },
            "seed",
        );
        assert!(omitted.is_empty());
    }

    #[test]
    fn xlsx_is_a_zip_with_the_ooxml_parts() {
        let bytes = build_xlsx("Test sheet", &[vec!["a".to_owned(), "b".to_owned()]]);
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("xl/workbook.xml"));
        assert!(text.contains("xl/worksheets/sheet1.xml"));
        assert!(text.contains("sheetData"));
    }

    #[test]
    fn invalid_window_is_refused() {
        let db = Db::memory().expect("db");
        let error = generate_statement(
            &db,
            "edfali",
            Some("2026-06-01T00:00:00.000Z"),
            Some("2026-01-01T00:00:00.000Z"),
            "json",
            &Anomalies::default(),
        )
        .expect_err("window");
        assert_eq!(error.code, "INVALID_WINDOW");
    }

    #[test]
    fn generated_statement_is_listed() {
        let db = Db::memory().expect("db");
        transaction(&db, "STMT-3", "PAID");
        let generated =
            generate_statement(&db, "edfali", None, None, "json", &Anomalies::default())
                .expect("statement");
        assert_eq!(generated.lines.len(), 1);
        let rows = db
            .query_json("SELECT * FROM fake_statements", vec![])
            .expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["gateway_code"], "edfali");
    }
}
