//! Clock and RNG adapters.
//!
//! `Date`/`Date.now()` and `crypto.randomUUID()`/`crypto.randomInt()` of the TypeScript engine.
//! Tests use [`FixedClock`] so a flow, a retry cooldown and a date transform are deterministic.

#![forbid(unsafe_code)]

use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::ports::{Clock, Rng};

/// The process clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

#[async_trait]
impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// A clock frozen at one instant. `sleep_ms` records the delay instead of waiting.
#[derive(Debug)]
pub struct FixedClock {
    now: Mutex<DateTime<Utc>>,
    sleeps: Mutex<Vec<u64>>,
}

impl FixedClock {
    #[must_use]
    pub fn new(now: DateTime<Utc>) -> Self {
        Self {
            now: Mutex::new(now),
            sleeps: Mutex::new(Vec::new()),
        }
    }

    /// A clock at an epoch-milliseconds instant.
    #[must_use]
    pub fn at(millis: i64) -> Self {
        let now = DateTime::<Utc>::from_timestamp_millis(millis)
            .unwrap_or_else(|| DateTime::<Utc>::from_timestamp(0, 0).unwrap_or_default());
        Self::new(now)
    }

    /// Moves the clock forward.
    pub fn advance(&self, milliseconds: i64) {
        if let Ok(mut now) = self.now.lock() {
            *now += Duration::milliseconds(milliseconds);
        }
    }

    /// The recorded `sleep_ms` arguments, in order.
    #[must_use]
    pub fn sleeps(&self) -> Vec<u64> {
        self.sleeps
            .lock()
            .map(|sleeps| sleeps.clone())
            .unwrap_or_default()
    }
}

#[async_trait]
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.now.lock().map(|now| *now).unwrap_or_default()
    }

    async fn sleep_ms(&self, milliseconds: u64) {
        if let Ok(mut sleeps) = self.sleeps.lock() {
            sleeps.push(milliseconds);
        }
    }
}

/// The OS RNG: v4 UUIDs and a uniform integer drawn from the UUID's 128 random bits.
#[derive(Debug, Clone, Copy, Default)]
pub struct OsRng;

impl Rng for OsRng {
    fn uuid(&self) -> Uuid {
        Uuid::new_v4()
    }

    fn int(&self, max_exclusive: u32) -> u32 {
        if max_exclusive == 0 {
            return 0;
        }
        let random = Uuid::new_v4().as_u128();
        u32::try_from(random % u128::from(max_exclusive)).unwrap_or(0)
    }
}

/// A deterministic RNG: UUIDs from a counter and integers from the same sequence.
#[derive(Debug)]
pub struct CounterRng {
    counter: Mutex<u128>,
}

impl CounterRng {
    #[must_use]
    pub fn new(start: u128) -> Self {
        Self {
            counter: Mutex::new(start),
        }
    }
}

impl Default for CounterRng {
    fn default() -> Self {
        Self::new(1)
    }
}

impl Rng for CounterRng {
    fn uuid(&self) -> Uuid {
        let next = self
            .counter
            .lock()
            .map(|mut counter| {
                let value = *counter;
                *counter += 1;
                value
            })
            .unwrap_or(0);
        // A v4-shaped UUID whose low bits carry the counter: deterministic but still valid.
        Uuid::from_u128((0x4_u128 << 76) | (0x2_u128 << 62) | (next & 0x0fff_ffff_ffff_ffff))
    }

    fn int(&self, max_exclusive: u32) -> u32 {
        if max_exclusive == 0 {
            return 0;
        }
        let next = self
            .counter
            .lock()
            .map(|mut counter| {
                let value = *counter;
                *counter += 1;
                value
            })
            .unwrap_or(0);
        u32::try_from(next % u128::from(max_exclusive)).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fixed_clock_records_sleeps() {
        let clock = FixedClock::at(1_700_000_000_000);
        assert_eq!(clock.now().timestamp_millis(), 1_700_000_000_000);
        clock.sleep_ms(250).await;
        clock.advance(1000);
        assert_eq!(clock.sleeps(), vec![250]);
        assert_eq!(clock.now().timestamp_millis(), 1_700_000_001_000);
    }

    #[test]
    fn counter_rng_is_deterministic_and_bounded() {
        let rng = CounterRng::new(1);
        assert_eq!(rng.int(10), 1);
        assert_eq!(rng.int(10), 2);
        assert_eq!(rng.int(0), 0);
        let first = rng.uuid();
        let second = rng.uuid();
        assert_ne!(first, second);
        assert_eq!(first.get_version_num(), 4);
    }
}
