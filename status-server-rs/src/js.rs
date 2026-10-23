//! JavaScript's ways of reading values, where the app (or the Node server's files) relies on them.

use serde_json::Value;

/// `Number(v)`: numbers as they are, strings parsed (empty is 0), booleans and null as 0 or 1,
/// anything else NaN.
pub fn number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let s = s.trim();
            if s.is_empty() { 0.0 } else { s.parse().unwrap_or(f64::NAN) }
        }
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => number(&a[0]),
        _ => f64::NAN,
    }
}

/// `Date.parse` for RFC 3339 times such as "2026-10-23T11:00:00.123456789-05:00", in ms.
pub fn parse_time(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-');
    let (year, month, day): (i64, i64, i64) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    let zone_at = rest.find(['Z', 'z', '+', '-'])?;
    let (clock, zone) = rest.split_at(zone_at);
    let mut c = clock.split(':');
    let (hour, minute): (i64, i64) = (c.next()?.parse().ok()?, c.next()?.parse().ok()?);
    let seconds: f64 = c.next()?.parse().ok()?;
    let offset_min = match zone {
        "Z" | "z" => 0,
        _ => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let (h, m) = zone[1..].split_once(':')?;
            sign * (h.parse::<i64>().ok()? * 60 + m.parse::<i64>().ok()?)
        }
    };
    // Days since 1970-01-01, from Howard Hinnant's days_from_civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 - offset_min * 60;
    Some(secs * 1000 + (seconds * 1000.0).floor() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers() {
        assert_eq!(number(&json!("12.5")), 12.5);
        assert_eq!(number(&json!("")), 0.0);
        assert_eq!(number(&json!(true)), 1.0);
        assert!(number(&json!("abc")).is_nan());
        assert!(number(&json!({})).is_nan());
    }

    #[test]
    fn times() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time("2026-10-23T11:00:00.123456789-05:00"), Some(1_792_771_200_123));
        assert_eq!(parse_time("2000-02-29T12:30:15+01:00"), Some(951_823_815_000));
        assert_eq!(parse_time("nonsense"), None);
    }
}
