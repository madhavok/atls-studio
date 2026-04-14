//! Embedding providers + reciprocal rank fusion (RRF) for hybrid search.
//!
//! The [`EmbeddingProvider`] trait abstracts over embedding implementations so the
//! indexer and search can swap between deterministic hashing and neural models.

use sha2::{Digest, Sha256};

pub const EMBEDDING_MODEL_ID: &str = "deterministic-v1";
pub const EMBEDDING_DIM: usize = 32;

// ---------------------------------------------------------------------------
// EmbeddingProvider trait
// ---------------------------------------------------------------------------

/// Trait for embedding text into a fixed-dimensional vector.
pub trait EmbeddingProvider: Send + Sync {
    fn embed(&self, text: &str) -> Vec<f32>;
    fn dim(&self) -> usize;
    fn model_id(&self) -> &str;
}

/// Hash-based deterministic embeddings (no ML runtime required).
pub struct DeterministicProvider;

impl EmbeddingProvider for DeterministicProvider {
    fn embed(&self, text: &str) -> Vec<f32> {
        deterministic_embed(text)
    }
    fn dim(&self) -> usize {
        EMBEDDING_DIM
    }
    fn model_id(&self) -> &str {
        EMBEDDING_MODEL_ID
    }
}

/// Return the default (deterministic) embedding provider.
pub fn default_provider() -> Box<dyn EmbeddingProvider> {
    Box::new(DeterministicProvider)
}

// ---------------------------------------------------------------------------
// Deterministic embedding (legacy standalone function kept for compatibility)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// In-memory vector index for fast similarity search
// ---------------------------------------------------------------------------

/// Threshold: build in-memory index when embedding count exceeds this.
const IN_MEMORY_INDEX_THRESHOLD: usize = 1000;

/// In-memory cache of symbol embeddings for fast cosine similarity search.
/// Avoids re-scanning the `symbol_embeddings` table on every query.
pub struct VectorIndex {
    ids: Vec<i64>,
    vecs: Vec<Vec<f32>>,
    dim: usize,
    loaded_count: usize,
}

impl VectorIndex {
    pub fn new(dim: usize) -> Self {
        Self { ids: Vec::new(), vecs: Vec::new(), dim, loaded_count: 0 }
    }

    /// Load all embeddings matching `dim` from the database.
    pub fn load_from_db(&mut self, conn: &rusqlite::Connection, dim: usize) -> Result<(), rusqlite::Error> {
        self.ids.clear();
        self.vecs.clear();
        self.dim = dim;

        let mut stmt = conn.prepare("SELECT symbol_id, vec FROM symbol_embeddings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        for row in rows {
            let (id, blob) = row?;
            let v = blob_to_vec(&blob);
            if v.len() == dim {
                self.ids.push(id);
                self.vecs.push(v);
            }
        }
        self.loaded_count = self.ids.len();
        Ok(())
    }

    /// Return top-k IDs by cosine similarity to `query_vec`.
    pub fn search(&self, query_vec: &[f32], k: usize) -> Vec<i64> {
        if self.ids.is_empty() || query_vec.len() != self.dim {
            return Vec::new();
        }
        let cap = k.min(200).max(1);
        let mut scored: Vec<(i64, f32)> = self.ids.iter()
            .zip(self.vecs.iter())
            .map(|(&id, v)| (id, cosine_similarity(query_vec, v)))
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.into_iter().take(cap).map(|(id, _)| id).collect()
    }

    pub fn len(&self) -> usize { self.loaded_count }
    pub fn is_empty(&self) -> bool { self.loaded_count == 0 }
}

/// Returns true if the embedding count warrants an in-memory index.
pub fn should_use_vector_index(count: usize) -> bool {
    count >= IN_MEMORY_INDEX_THRESHOLD
}

// ---------------------------------------------------------------------------
// ONNX-based neural embedding provider (behind `neural-embeddings` feature)
// ---------------------------------------------------------------------------

#[cfg(feature = "neural-embeddings")]
pub mod onnx {
    use super::EmbeddingProvider;
    use std::path::PathBuf;
    use std::sync::Mutex;

    pub struct OnnxEmbeddingProvider {
        session: Mutex<ort::Session>,
        dim: usize,
        model_id: String,
    }

    impl OnnxEmbeddingProvider {
        /// Load an ONNX sentence-transformer model from `model_path`.
        /// The model must accept `input_ids` and `attention_mask` (int64)
        /// and produce a pooled embedding output.
        pub fn new(model_path: PathBuf, dim: usize, model_id: &str) -> Result<Self, Box<dyn std::error::Error>> {
            let session = ort::Session::builder()?
                .with_optimization_level(ort::GraphOptimizationLevel::Level3)?
                .with_intra_threads(1)?
                .commit_from_file(&model_path)?;
            Ok(Self {
                session: Mutex::new(session),
                dim,
                model_id: model_id.to_string(),
            })
        }

        fn simple_tokenize(text: &str) -> (Vec<i64>, Vec<i64>) {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return (vec![0], vec![0]);
            }
            let tokens: Vec<i64> = trimmed.bytes().map(|b| b as i64).collect();
            let mask = vec![1i64; tokens.len()];
            (tokens, mask)
        }
    }

    impl EmbeddingProvider for OnnxEmbeddingProvider {
        fn embed(&self, text: &str) -> Vec<f32> {
            let (input_ids, attention_mask) = Self::simple_tokenize(text);
            let len = input_ids.len();

            let ids_array = ndarray::Array2::from_shape_vec((1, len), input_ids)
                .expect("input_ids shape");
            let mask_array = ndarray::Array2::from_shape_vec((1, len), attention_mask)
                .expect("attention_mask shape");

            let session = self.session.lock().expect("onnx session lock");
            let outputs = match session.run(ort::inputs![ids_array, mask_array]) {
                Ok(o) => o,
                Err(_) => return vec![0.0; self.dim],
            };

            let Some(output) = outputs.first() else {
                return vec![0.0; self.dim];
            };
            let Ok(tensor) = output.1.try_extract_tensor::<f32>() else {
                return vec![0.0; self.dim];
            };

            let view = tensor.view();
            let flat: Vec<f32> = view.iter().copied().collect();
            if flat.len() >= self.dim {
                let mut v = flat[..self.dim].to_vec();
                let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                if norm > 1e-9 {
                    for x in &mut v {
                        *x /= norm;
                    }
                }
                v
            } else {
                vec![0.0; self.dim]
            }
        }

        fn dim(&self) -> usize {
            self.dim
        }

        fn model_id(&self) -> &str {
            &self.model_id
        }
    }
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
