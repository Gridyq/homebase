//! D-Bus, spoken directly instead of through busctl: udisks for the drives, and systemd's and
//! udisks' signals, so a service that starts, stops or crashes and a drive whose health or mounts
//! change are noticed within a second or two instead of at the next reading.
//!
//! Replies are turned into the JSON `busctl --json=short` printed, which drives.rs was written
//! against: variants as `{ type, data }`, structs as arrays, dictionaries as objects.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, OnceCell};
use zbus::message::Type as MessageType;
use zbus::zvariant::{Structure, Value as Variant};
use zbus::{Connection, MatchRule, MessageStream};

use crate::http::State;

/// Quiet this long after the last signal before looking, so a restart's stop and start are seen
/// together rather than as a stop and then a start.
const SETTLE: Duration = Duration::from_millis(1500);
const RECONNECT: Duration = Duration::from_secs(30);
/// The system units the dashboard shows (see `UNITS`), as systemd names their objects.
const SYSTEM_UNIT_PATHS: &[&str] = &["/org/freedesktop/systemd1/unit/tailscaled_2eservice"];

static SYSTEM: OnceCell<Connection> = OnceCell::const_new();

async fn system_bus() -> zbus::Result<&'static Connection> {
    SYSTEM.get_or_try_init(Connection::system).await
}

/// A D-Bus value as busctl's JSON writes it.
pub fn to_json(v: &Variant) -> Value {
    match v {
        Variant::U8(n) => json!(n),
        Variant::Bool(b) => json!(b),
        Variant::I16(n) => json!(n),
        Variant::U16(n) => json!(n),
        Variant::I32(n) => json!(n),
        Variant::U32(n) => json!(n),
        Variant::I64(n) => json!(n),
        Variant::U64(n) => json!(n),
        Variant::F64(n) => json!(n),
        Variant::Str(s) => json!(s.as_str()),
        Variant::Signature(s) => json!(s.to_string()),
        Variant::ObjectPath(p) => json!(p.as_str()),
        Variant::Value(inner) => json!({ "type": inner.value_signature().to_string(), "data": to_json(inner) }),
        Variant::Array(a) => Value::Array(a.inner().iter().map(to_json).collect()),
        Variant::Dict(d) => {
            let mut out = Map::new();
            for (k, v) in d.iter() {
                let key = match to_json(k) {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                out.insert(key, to_json(v));
            }
            Value::Object(out)
        }
        Variant::Structure(s) => Value::Array(s.fields().iter().map(to_json).collect()),
        #[allow(unreachable_patterns)]
        _ => Value::Null,
    }
}

/// Calls a method on the system bus; its results as busctl's `data`, one item per result.
pub async fn system_call(destination: &str, path: &str, interface: &str, method: &str, options: bool) -> Result<Value, String> {
    let bus = system_bus().await.map_err(|e| e.to_string())?;
    let reply = if options {
        let none = std::collections::HashMap::<&str, Variant>::new();
        bus.call_method(Some(destination), path, Some(interface), method, &(none,)).await
    } else {
        bus.call_method(Some(destination), path, Some(interface), method, &()).await
    }
    .map_err(|e| e.to_string())?;
    let body = reply.body();
    let fields: Structure = body.deserialize().map_err(|e| e.to_string())?;
    Ok(Value::Array(fields.fields().iter().map(to_json).collect()))
}

/// Waits for `wake`, then for things to go quiet, then calls `act`; for as long as the server runs.
fn settle_then<F, Fut>(wake: Arc<Notify>, quiet: Duration, act: F)
where
    F: Fn() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    tokio::spawn(async move {
        loop {
            wake.notified().await;
            while tokio::time::timeout(quiet, wake.notified()).await.is_ok() {}
            act().await;
        }
    });
}

pub fn start(state: State) {
    let units = Arc::new(Notify::new());
    let s = state.clone();
    settle_then(Arc::clone(&units), SETTLE, move || {
        let s = s.clone();
        async move { crate::recorder::check_services(&s).await }
    });
    tokio::spawn(follow(Arc::clone(&units), false));
    tokio::spawn(follow(units, true));

    let drives = Arc::new(Notify::new());
    let s = state.clone();
    settle_then(Arc::clone(&drives), Duration::from_secs(3), move || {
        let s = s.clone();
        async move { crate::recorder::refresh_drives(&s).await }
    });
    tokio::spawn(follow_udisks(drives));
}

/// Follows the user's or the system's units, reconnecting if the bus goes away.
async fn follow(wake: Arc<Notify>, system: bool) {
    let bus = if system { "system" } else { "user" };
    loop {
        if let Err(e) = follow_units(&wake, system).await {
            eprintln!("Following the {bus} services stopped: {e}");
        }
        tokio::time::sleep(RECONNECT).await;
    }
}

async fn follow_units(wake: &Notify, system: bool) -> zbus::Result<()> {
    let conn = if system { system_bus().await?.clone() } else { Connection::session().await? };
    let rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .sender("org.freedesktop.systemd1")?
        .interface("org.freedesktop.DBus.Properties")?
        .member("PropertiesChanged")?
        .path_namespace("/org/freedesktop/systemd1/unit")?
        .build();
    let mut stream = MessageStream::for_match_rule(rule, &conn, Some(256.try_into().unwrap())).await?;
    // systemd only sends its signals while someone has asked for them.
    let subscribed = conn
        .call_method(
            Some("org.freedesktop.systemd1"),
            "/org/freedesktop/systemd1",
            Some("org.freedesktop.systemd1.Manager"),
            "Subscribe",
            &(),
        )
        .await;
    if let Err(e) = subscribed {
        eprintln!("Couldn't subscribe to systemd's signals: {e}");
    }
    println!("Following the {} services over D-Bus", if system { "system" } else { "user" });
    while let Some(msg) = stream.next().await {
        let msg = msg?;
        let header = msg.header();
        let Some(path) = header.path().map(|p| p.as_str().to_owned()) else { continue };
        if system && !SYSTEM_UNIT_PATHS.contains(&path.as_str()) {
            continue;
        }
        if !system && !watched_unit(&path) {
            continue;
        }
        let Ok((iface, changed, _)) = msg
            .body()
            .deserialize::<(String, std::collections::HashMap<String, zbus::zvariant::OwnedValue>, Vec<String>)>()
        else {
            continue;
        };
        if iface == "org.freedesktop.systemd1.Unit" && (changed.contains_key("ActiveState") || changed.contains_key("SubState")) {
            wake.notify_one();
        }
    }
    Err(zbus::Error::Failure("the bus closed the stream".into()))
}

/// Services and timers; not the scopes and slices desktop apps come and go in.
fn watched_unit(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or_default();
    name.ends_with("_2eservice") || name.ends_with("_2etimer")
}

/// Any change udisks announces: SMART data read, a drive plugged in, something mounted.
async fn follow_udisks(wake: Arc<Notify>) {
    loop {
        let result = async {
            let conn = system_bus().await?;
            let rule = MatchRule::builder()
                .msg_type(MessageType::Signal)
                .sender("org.freedesktop.UDisks2")?
                .build();
            let mut stream = MessageStream::for_match_rule(rule, conn, Some(256.try_into().unwrap())).await?;
            while let Some(msg) = stream.next().await {
                msg?;
                wake.notify_one();
            }
            Ok::<_, zbus::Error>(())
        }
        .await;
        if let Err(e) = result {
            eprintln!("Following udisks stopped: {e}");
        }
        tokio::time::sleep(RECONNECT).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use zbus::zvariant::{ObjectPath, Value as V};

    #[test]
    fn values_look_like_busctl_json() {
        let mut props: HashMap<&str, V> = HashMap::new();
        // As an a{sv}, each value is a variant.
        props.insert("Model", V::from("Disk"));
        props.insert("Device", V::from(vec![47u8, 100, 0]));
        let v = V::from(props);
        assert_eq!(
            to_json(&v),
            json!({ "Model": { "type": "s", "data": "Disk" }, "Device": { "type": "ay", "data": [47, 100, 0] } })
        );
        let row = V::from((5u8, "reallocated", 0u16, 100i32, 100i32, 10i32, 3i64, 1i32));
        assert_eq!(to_json(&row), json!([5, "reallocated", 0, 100, 100, 10, 3, 1]));
        assert_eq!(to_json(&V::from(ObjectPath::try_from("/a/b").unwrap())), json!("/a/b"));
        assert!(watched_unit("/org/freedesktop/systemd1/unit/sonarr_2eservice"));
        assert!(!watched_unit("/org/freedesktop/systemd1/unit/app_2dorg_2ekde_2ekonsole_2d12_2escope"));
    }
}
