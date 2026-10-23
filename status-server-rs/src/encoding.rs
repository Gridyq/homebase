//! Base64, for photos sent to the model and for tokens and pairing codes.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

pub fn base64(data: &[u8]) -> String {
    STANDARD.encode(data)
}

/// URL-safe and unpadded, as Node's `toString('base64url')`.
pub fn base64url(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

/// Bytes from the system's random source. Panics if there's none, rather than hand out zeros
/// for a token.
pub fn random_bytes(n: usize) -> Vec<u8> {
    use ring::rand::SecureRandom;
    let mut b = vec![0u8; n];
    ring::rand::SystemRandom::new().fill(&mut b).expect("the system's random source failed");
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_node() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }
}
