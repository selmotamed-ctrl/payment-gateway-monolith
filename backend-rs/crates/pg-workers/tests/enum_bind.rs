//! Verifies that generated sqlx enum types bind with their quoted PostgreSQL type names.

use pg_types::generated::enums::{AttemptStatus, OperatorCaseKind};
use sqlx::postgres::PgPoolOptions;

#[tokio::test]
async fn generated_enum_binds_and_decodes() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("SKIP: DATABASE_URL is not set");
        return;
    };
    let pool = match PgPoolOptions::new().max_connections(1).connect(&url).await {
        Ok(pool) => pool,
        Err(error) => {
            eprintln!("SKIP: database unavailable: {error}");
            return;
        }
    };
    let value: OperatorCaseKind = sqlx::query_scalar("SELECT $1::\"OperatorCaseKind\"")
        .bind(OperatorCaseKind::Unknown)
        .fetch_one(&pool)
        .await
        .expect("bind generated enum");
    assert_eq!(value, OperatorCaseKind::Unknown);
    let status: AttemptStatus = sqlx::query_scalar("SELECT $1::\"AttemptStatus\"")
        .bind(AttemptStatus::Succeeded)
        .fetch_one(&pool)
        .await
        .expect("bind AttemptStatus");
    assert_eq!(status, AttemptStatus::Succeeded);
}
