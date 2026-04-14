//! Deterministic embedding + reciprocal rank fusion (RRF) for hybrid search.

use sha2::{Digest, Sha256};

pub const EMBEDDING_MODEL_ID: &str = "deterministic-v1";
pub const EMBEDDING_DIM: usize = 32;

/// Stable length-32 embedding from text (not semantic; enables hybrid plumbing without ONNX).
#[must_use]
pub fn deterministic_embed(text: &str) -> Vec<f32> {
    let mut out = Vec::with_capacity(EMBEDDING_DIM);
    let base = text.trim();
    if base.is_empty() {
        return vec![0.0; EMBEDDING_DIM];
    }
    let mut seed = format!("{:x}", Sha256::digest(base.as_bytes()));
    while out.len() < EMBEDDING_DIM {
        seed = format!("{:x}", Sha256::digest(seed.as_bytes()));
        for chunk in seed.as_bytes().chunks(4) {
            if out.len() >= EMBEDDING_DIM {
                break;
            }
            let mut b = [0u8; 4];
            b[..chunk.len()].copy_from_slice(chunk);
            out.push(f32::from_le_bytes(b).tanh());
        }
    }
    out
}

#[must_use]
pub fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(v.len() * 4);
    for x in v {
        b.extend_from_slice(&x.to_le_bytes());
    }
    b
}

#[must_use]
pub fn blob_to_vec(blob: &[u8]) -> Vec<f32> {
    blob
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut na = 0.0_f64;
    let mut nb = 0.0_f64;
    for i in 0..a.len() {
        let x = a[i] as f64;
        let y = b[i] as f64;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na <= 1e-12 || nb <= 1e-12 {
        return 0.0;
    }
    (dot / (na.sqrt() * nb.sqrt())) as f32
}

/// RRF merge: `score(d) = sum_i 1/(k + rank_i(d))` over ranked id lists (1-based ranks).
#[must_use]
pub fn reciprocal_rank_fusion_ids(lists: &[Vec<i64>], k: f64) -> Vec<(i64, f64)> {
    use std::collections::HashMap;
    let mut acc: HashMap<i64, f64> = HashMap::new();
    for list in lists {
        for (idx, id) in list.iter().enumerate() {
            let rank = (idx + 1) as f64;
            *acc.entry(*id).or_insert(0.0) += 1.0 / (k + rank);
        }
    }
    let mut v: Vec<(i64, f64)> = acc.into_iter().collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embed_deterministic() {
        let a = deterministic_embed("fn foo() {}");
        let b = deterministic_embed("fn foo() {}");
        let c = deterministic_embed("struct Bar");
        assert_eq!(a.len(), EMBEDDING_DIM);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn rrf_orders_by_overlap() {
        let lists = vec![vec![1, 2, 3], vec![3, 1, 4]];
        let m = reciprocal_rank_fusion_ids(&lists, 60.0);
        assert_eq!(m[0].0, 1);
        assert_eq!(m[1].0, 3);
    }
}
