//! Times in the server's own time zone, written and read the way the assistant's tools use them:
//! the same text JavaScript's `toLocaleTimeString('en-GB')` and `toLocaleDateString('en-US')` give.

const WEEKDAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn local(ms: i64) -> libc::tm {
    let secs = ms.div_euclid(1000) as libc::time_t;
    // SAFETY: localtime_r fills `tm` from `secs`; both are valid for the call.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    tm
}

/// The hour of the day, 0–23.
pub fn hour(ms: i64) -> i32 {
    local(ms).tm_hour
}

/// "14:05", 24-hour.
pub fn clock(ms: i64) -> String {
    let tm = local(ms);
    format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
}

/// "2026-10-22 23:00", the form the tools take times in.
pub fn tool_time(ms: i64) -> String {
    let tm = local(ms);
    format!(
        "{}-{:02}-{:02} {:02}:{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min
    )
}

/// "Fri, Oct 23 14:05".
pub fn day_time(ms: i64) -> String {
    let tm = local(ms);
    format!(
        "{}, {} {} {}",
        &WEEKDAYS[tm.tm_wday as usize][..3],
        &MONTHS[tm.tm_mon as usize][..3],
        tm.tm_mday,
        clock(ms)
    )
}

/// "Friday, October 23, 2026".
pub fn long_date(ms: i64) -> String {
    let tm = local(ms);
    format!(
        "{}, {} {}, {}",
        WEEKDAYS[tm.tm_wday as usize],
        MONTHS[tm.tm_mon as usize],
        tm.tm_mday,
        tm.tm_year + 1900
    )
}

fn same_day(a: i64, b: i64) -> bool {
    let (x, y) = (local(a), local(b));
    (x.tm_year, x.tm_yday) == (y.tm_year, y.tm_yday)
}

/// A stretch of time for a step's label, without the day twice.
pub fn span(from: i64, to: i64) -> String {
    format!("{}–{}", day_time(from), if same_day(from, to) { clock(to) } else { day_time(to) })
}

/// A time a model gave, as `Date.parse` reads ISO times: a date alone is UTC midnight, a date and
/// time without a zone is local, and one with Z or an offset is that.
pub fn parse(value: &str) -> Option<i64> {
    let v = value.trim().replacen(' ', "T", 1);
    let (date, time) = match v.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (v.as_str(), None),
    };
    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next().map_or(Some(1), |m| m.parse().ok())?;
    let day: i64 = d.next().map_or(Some(1), |m| m.parse().ok())?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || d.next().is_some() {
        return None;
    }
    let Some(time) = time else {
        return crate::js::parse_time(&format!("{year:04}-{month:02}-{day:02}T00:00:00Z"));
    };
    if time.ends_with(['Z', 'z']) || time.contains(['+']) || time.rfind('-').is_some() {
        return crate::js::parse_time(&format!("{year:04}-{month:02}-{day:02}T{}", with_seconds(time)?));
    }
    let clock = with_seconds(time)?;
    let mut c = clock.split(':');
    let (hour, minute): (i32, i32) = (c.next()?.parse().ok()?, c.next()?.parse().ok()?);
    let seconds: f64 = c.next()?.parse().ok()?;
    if hour > 24 || minute > 59 || seconds >= 60.0 {
        return None;
    }
    // SAFETY: mktime reads and normalizes `tm`, which is a valid, fully set struct.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = (year - 1900) as i32;
    tm.tm_mon = (month - 1) as i32;
    tm.tm_mday = day as i32;
    tm.tm_hour = hour;
    tm.tm_min = minute;
    tm.tm_sec = seconds.floor() as i32;
    tm.tm_isdst = -1;
    let secs = unsafe { libc::mktime(&mut tm) };
    (secs != -1).then(|| secs as i64 * 1000 + (seconds.fract() * 1000.0).floor() as i64)
}

/// "23:00" → "23:00:00", keeping a zone at the end.
fn with_seconds(time: &str) -> Option<String> {
    let zone_at = time.find(['Z', 'z', '+', '-']).unwrap_or(time.len());
    let (clock, zone) = time.split_at(zone_at);
    let parts = clock.split(':').count();
    match parts {
        2 => Some(format!("{clock}:00{zone}")),
        3 => Some(time.to_owned()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_in_local_time() {
        let t = parse("2026-10-22 23:05").unwrap();
        assert_eq!(tool_time(t), "2026-10-22 23:05");
        assert_eq!(clock(t), "23:05");
        assert!(day_time(t).ends_with("Oct 22 23:05"), "{}", day_time(t));
        assert_eq!(parse("2026-10-22"), Some(1_792_627_200_000));
        assert_eq!(parse("2026-10-22T23:05:00Z"), Some(1_792_710_300_000));
        assert_eq!(parse("yesterday"), None);
        assert_eq!(parse("2026-13-01 10:00"), None);
    }
}
