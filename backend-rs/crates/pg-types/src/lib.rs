//! Shared value types that must serialise like the TypeScript implementation.
//!
//! - [`Money4`] reproduces the `toFixed(4)` money fields used by several admin/merchant handlers.
//! - [`DecimalJs`] reproduces decimal.js `toString()` (Prisma Decimal through `JSON.stringify`).
//! - [`JsDate`] reproduces `Date#toISOString()` (always three fraction digits).
//! - [`js_object_order`] reproduces JavaScript object key ordering for dynamic maps.
//!
//! Ports: `core-back/api/internal/adminCommerce.ts:78` (Money4), decimal.js `toString`
//! (chapter 2 §12/§13), `lib/storageEngine/utcSession.ts` date handling.

#![forbid(unsafe_code)]

pub mod cursor;
pub mod generated;
pub mod ids;
pub mod js_number;
pub mod json_order;
pub mod money;
pub mod time;

pub use cursor::CursorCodec;
pub use ids::{cuid, new_v4, new_v7};
pub use js_number::{js_number_to_string, JsNumber};
pub use json_order::{js_object_order, js_object_order_string};
pub use money::{DecimalJs, Money4, MoneyParseError, RoundingMode};
pub use time::JsDate;
