//! Criterion benchmark for P0-T09. Each allocator is a separate build (`--features`).

use allocator_bench::{
    churn_medium, churn_small, sample_event, sample_json, typed_roundtrip, value_roundtrip,
    ALLOCATOR,
};
use criterion::{criterion_group, criterion_main, BatchSize, Criterion, Throughput};
use std::hint::black_box;

fn json_documents() -> Vec<String> {
    // 64 distinct ~1.3 kB documents (the parse/validate/serialise cycle of one request).
    (0..64).map(sample_json).collect()
}

fn json_paths(c: &mut Criterion) {
    let documents = json_documents();
    let total_bytes: usize = documents.iter().map(String::len).sum();

    let mut group = c.benchmark_group("json");
    group.throughput(Throughput::Bytes(total_bytes as u64));

    group.bench_function("parse_to_value", |b| {
        b.iter(|| {
            for document in &documents {
                let value: serde_json::Value = serde_json::from_str(document).unwrap();
                black_box(value);
            }
        })
    });

    group.bench_function("value_roundtrip", |b| {
        b.iter(|| {
            for document in &documents {
                black_box(value_roundtrip(document));
            }
        })
    });

    group.bench_function("typed_roundtrip", |b| {
        b.iter(|| {
            for document in &documents {
                black_box(typed_roundtrip(document));
            }
        })
    });

    group.bench_function("serialize", |b| {
        let events: Vec<_> = (0..64).map(sample_event).collect();
        b.iter(|| {
            for event in &events {
                black_box(serde_json::to_string(event).unwrap());
            }
        })
    });

    group.finish();
}

fn allocation_churn(c: &mut Criterion) {
    let mut group = c.benchmark_group("alloc");

    group.bench_function("churn_small_1000", |b| {
        b.iter(|| black_box(churn_small(black_box(1_000))))
    });

    group.bench_function("churn_medium_250", |b| {
        b.iter(|| black_box(churn_medium(black_box(250))))
    });

    // A realistic mixed burst: one parsed body + one typed round trip + churn, repeated.
    group.bench_function("mixed_burst", |b| {
        let documents = json_documents();
        b.iter_batched(
            || documents[0].clone(),
            |document| {
                let value = value_roundtrip(&document);
                let typed = typed_roundtrip(&document);
                let churn = churn_small(50);
                black_box((value.len(), typed.len(), churn))
            },
            BatchSize::SmallInput,
        )
    });

    group.finish();
}

fn bench(c: &mut Criterion) {
    eprintln!("allocator under test: {ALLOCATOR}");
    json_paths(c);
    allocation_churn(c);
}

criterion_group!(benches, bench);
criterion_main!(benches);
