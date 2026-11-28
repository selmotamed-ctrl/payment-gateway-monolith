//! Port of `deploy/backup-daemon/test/mtlsAuthorization.test.ts` and the role half of
//! `mtlsRoles.test.ts` (the live TLS sockets are covered by `pg-mtls`'s own tests).

use backup_daemon::server::{caller_role_for_identity, CallerRole};
use pg_mtls::PeerIdentity;

fn identity(cns: &[&str], sans: &[&str]) -> PeerIdentity {
    PeerIdentity {
        common_names: cns.iter().map(|value| (*value).to_owned()).collect(),
        dns_names: sans.iter().map(|value| (*value).to_owned()).collect(),
        ip_addresses: Vec::new(),
        authorized_by_ca: true,
    }
}

#[test]
fn the_control_plane_matches_subject_cn_or_dns_san() {
    let control = vec!["backup-client".to_owned()];
    let wal = vec!["wal-archive-client".to_owned()];
    assert_eq!(
        caller_role_for_identity(
            Some(&identity(&["backup-client"], &[])),
            &control,
            &wal,
            true
        ),
        Some(CallerRole::Control)
    );
    assert_eq!(
        caller_role_for_identity(
            Some(&identity(&[], &["backup-client"])),
            &control,
            &wal,
            true
        ),
        Some(CallerRole::Control)
    );
    assert_eq!(
        caller_role_for_identity(
            Some(&identity(&["wal-archive-client"], &[])),
            &control,
            &wal,
            true
        ),
        Some(CallerRole::Wal)
    );
    assert_eq!(
        caller_role_for_identity(Some(&identity(&["nginx"], &[])), &control, &wal, true),
        None
    );
    assert_eq!(caller_role_for_identity(None, &control, &wal, true), None);
}

#[test]
fn plain_http_development_mode_has_the_open_role() {
    assert_eq!(
        caller_role_for_identity(None, &[], &[], false),
        Some(CallerRole::Open)
    );
}

#[test]
fn the_control_plane_wins_when_a_certificate_is_in_both_lists() {
    let both = vec!["backup-client".to_owned()];
    assert_eq!(
        caller_role_for_identity(Some(&identity(&["backup-client"], &[])), &both, &both, true),
        Some(CallerRole::Control)
    );
}
