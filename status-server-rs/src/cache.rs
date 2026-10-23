//! A reading that's slow to take and asked for every few seconds. One younger than `stale_after`
//! is answered as is, and one younger than `max_age` is answered while a fresh one is taken in
//! the background. Only one reading is taken at a time; whoever waited for it gets that one.
//! After changing what it reads, `expire` makes the next call wait for a fresh one.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct Refreshed<T, F> {
    take: F,
    stale_after: Duration,
    max_age: Duration,
    label: &'static str,
    last: Mutex<Option<(Arc<T>, Instant)>>,
    taking: tokio::sync::Mutex<()>,
    /// Bumped on expiry, so a reading that started before a change isn't kept as fresh.
    generation: AtomicU64,
}

impl<T, F, Fut> Refreshed<T, F>
where
    T: Send + Sync + 'static,
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<T, String>> + Send,
{
    pub fn new(label: &'static str, stale_after: Duration, max_age: Duration, take: F) -> Arc<Self> {
        Arc::new(Self {
            take,
            stale_after,
            max_age,
            label,
            last: Mutex::new(None),
            taking: Default::default(),
            generation: AtomicU64::new(0),
        })
    }

    pub async fn get(self: &Arc<Self>) -> Result<Arc<T>, String> {
        let last = self.last.lock().unwrap().clone();
        match last {
            Some((value, at)) if at.elapsed() < self.max_age => {
                if at.elapsed() >= self.stale_after {
                    let this = Arc::clone(self);
                    tokio::spawn(async move {
                        if let Err(e) = this.refresh().await {
                            eprintln!("{} failed: {e}", this.label);
                        }
                    });
                }
                Ok(value)
            }
            _ => self.refresh().await,
        }
    }

    /// A reading no older than `stale_after`, waiting for a new one if need be.
    pub async fn get_fresh(&self) -> Result<Arc<T>, String> {
        self.refresh().await
    }

    async fn refresh(&self) -> Result<Arc<T>, String> {
        let _taking = self.taking.lock().await;
        // Taken by someone else while this waited its turn.
        if let Some((value, at)) = self.last.lock().unwrap().clone()
            && at.elapsed() < self.stale_after
        {
            return Ok(value);
        }
        let started = self.generation.load(Ordering::SeqCst);
        let value = Arc::new((self.take)().await?);
        let mut last = self.last.lock().unwrap();
        if self.generation.load(Ordering::SeqCst) == started {
            *last = Some((Arc::clone(&value), Instant::now()));
        }
        Ok(value)
    }

    pub fn expire(&self) {
        let mut last = self.last.lock().unwrap();
        self.generation.fetch_add(1, Ordering::SeqCst);
        *last = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn serves_stale_while_refreshing_and_takes_one_reading_at_a_time() {
        let calls = Arc::new(AtomicU32::new(0));
        let counter = Arc::clone(&calls);
        let cache = Refreshed::new("test", Duration::from_millis(100), Duration::from_millis(300), move || {
            let counter = Arc::clone(&counter);
            async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(counter.fetch_add(1, Ordering::SeqCst) + 1)
            }
        });

        let (a, b) = tokio::join!(cache.get(), cache.get());
        assert_eq!((*a.unwrap(), *b.unwrap()), (1, 1), "two first callers share one reading");
        assert_eq!(*cache.get().await.unwrap(), 1, "fresh is served without reading");

        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(*cache.get().await.unwrap(), 1, "stale is served at once");
        assert_eq!(*cache.get().await.unwrap(), 1);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(*cache.get().await.unwrap(), 2, "background reading landed, only one taken");

        tokio::time::sleep(Duration::from_millis(350)).await;
        assert_eq!(*cache.get().await.unwrap(), 3, "too old: waits for a new one");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_reading_from_before_expiry_is_not_kept() {
        let state = Arc::new(AtomicU32::new(1));
        let source = Arc::clone(&state);
        let cache = Refreshed::new("test", Duration::from_secs(10), Duration::from_secs(20), move || {
            let source = Arc::clone(&source);
            async move {
                let value = source.load(Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(value)
            }
        });
        let early = tokio::spawn({
            let cache = Arc::clone(&cache);
            async move { cache.get().await }
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        // Something changes while that reading is under way.
        state.store(2, Ordering::SeqCst);
        cache.expire();
        assert_eq!(*early.await.unwrap().unwrap(), 1);
        assert_eq!(*cache.get().await.unwrap(), 2, "waits for a reading taken after the change");
        assert_eq!(*cache.get().await.unwrap(), 2);
    }

    #[tokio::test]
    async fn errors_reach_a_caller_that_waits() {
        let cache = Refreshed::new("test", Duration::from_secs(1), Duration::from_secs(2), || async {
            Err::<(), _>("nope".to_owned())
        });
        assert_eq!(cache.get().await.unwrap_err(), "nope");
    }
}
