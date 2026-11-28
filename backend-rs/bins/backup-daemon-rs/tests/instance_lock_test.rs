//! Port of `deploy/backup-daemon/test/instanceLock.test.ts`.

use std::path::PathBuf;

use backup_daemon::instance_lock::{acquire_instance_lock, InstanceLockDeps};

fn scratch() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("state").join("daemon.lock");
    (directory, path)
}

#[tokio::test]
async fn a_live_holder_blocks_a_second_daemon_and_release_lets_the_next_one_in() {
    let (_directory, path) = scratch();
    let first = acquire_instance_lock(
        &path,
        InstanceLockDeps::new()
            .with_pid(1111)
            .with_alive(|_| true)
            .with_command_line(|_| Some("bun run src/index.ts".to_owned())),
    )
    .await
    .expect("first");
    let blocked = acquire_instance_lock(
        &path,
        InstanceLockDeps::new()
            .with_pid(2222)
            .with_alive(|pid| pid == 1111)
            .with_command_line(|_| Some("bun run src/index.ts".to_owned())),
    )
    .await;
    let message = blocked.err().expect("blocked").0;
    assert!(message.contains("pid 1111"), "{message}");

    first.release().await;
    assert!(!path.exists());
    let second = acquire_instance_lock(&path, InstanceLockDeps::new().with_pid(2222)).await;
    assert!(second.is_ok());
}

#[tokio::test]
async fn a_stale_lock_from_a_crashed_holder_is_taken_over() {
    let (_directory, path) = scratch();
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(
        &path,
        r#"{"pid":999999,"startedAt":"2026-01-01T00:00:00Z"}"#,
    )
    .expect("write");
    let lock = acquire_instance_lock(
        &path,
        InstanceLockDeps::new().with_pid(3333).with_alive(|_| false),
    )
    .await
    .expect("takeover");
    let holder: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
    assert_eq!(holder["pid"], 3333);
    lock.release().await;
}

#[tokio::test]
async fn a_recycled_pid_belonging_to_an_unrelated_program_does_not_block() {
    let (_directory, path) = scratch();
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&path, r#"{"pid":4444}"#).expect("write");
    let lock = acquire_instance_lock(
        &path,
        InstanceLockDeps::new()
            .with_pid(5555)
            .with_alive(|_| true)
            .with_command_line(|_| Some("/usr/bin/nginx -g daemon off".to_owned())),
    )
    .await
    .expect("takeover");
    let holder: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
    assert_eq!(holder["pid"], 5555);
    lock.release().await;
}

#[tokio::test]
async fn a_corrupt_lock_file_is_treated_as_stale() {
    let (_directory, path) = scratch();
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&path, "{not json").expect("write");
    let lock = acquire_instance_lock(&path, InstanceLockDeps::new().with_pid(6666))
        .await
        .expect("takeover");
    let holder: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
    assert_eq!(holder["pid"], 6666);
    lock.release().await;
}

#[tokio::test]
async fn release_never_removes_a_lock_that_now_belongs_to_someone_else() {
    let (_directory, path) = scratch();
    let mine = acquire_instance_lock(&path, InstanceLockDeps::new().with_pid(7777))
        .await
        .expect("lock");
    std::fs::write(&path, r#"{"pid":8888}"#).expect("write");
    mine.release().await;
    let holder: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
    assert_eq!(holder["pid"], 8888);
}

#[tokio::test]
async fn simultaneous_starts_never_produce_two_holders() {
    let (directory, _) = scratch();
    for round in 0..80_u32 {
        let path = directory.path().join(format!("round-{round}.lock"));
        let mut handles = Vec::new();
        for n in 1..=4 {
            let path = path.clone();
            let pid = 1000 + n;
            handles.push(tokio::spawn(async move {
                acquire_instance_lock(
                    &path,
                    InstanceLockDeps::new()
                        .with_pid(pid)
                        .with_alive(|_| true)
                        .with_command_line(|_| Some("backup-daemon-rs serve".to_owned())),
                )
                .await
            }));
        }
        let mut winners = 0;
        for handle in handles {
            if matches!(handle.await, Ok(Ok(_))) {
                winners += 1;
            }
        }
        assert_eq!(winners, 1, "round {round}");
        let holder: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert!([1001, 1002, 1003, 1004].contains(&(holder["pid"].as_i64().expect("pid") as i32)));
    }
}

#[tokio::test]
async fn simultaneous_takeovers_of_one_stale_lock_still_end_with_exactly_one_holder() {
    let (directory, _) = scratch();
    for round in 0..40_u32 {
        let path = directory.path().join(format!("stale-{round}.lock"));
        std::fs::write(
            &path,
            r#"{"pid":999999,"startedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .expect("write");
        let mut handles = Vec::new();
        for n in 1..=3 {
            let path = path.clone();
            let pid = 1000 + n;
            handles.push(tokio::spawn(async move {
                acquire_instance_lock(
                    &path,
                    InstanceLockDeps::new()
                        .with_pid(pid)
                        .with_alive(|pid| (1000..2000).contains(&pid))
                        .with_command_line(|_| Some("backup-daemon-rs serve".to_owned())),
                )
                .await
            }));
        }
        let mut winners = 0;
        for handle in handles {
            if matches!(handle.await, Ok(Ok(_))) {
                winners += 1;
            }
        }
        assert_eq!(winners, 1, "round {round}");
    }
}
