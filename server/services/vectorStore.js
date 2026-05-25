import logger from '../logger.js';
// server/services/vectorStore.js
// P2: sqlite-vec + 真正的 RAG（替换 ORDER BY confidence 假 RAG）
//
// 算法：Feature Hashing（Hashing Trick，Weinberger 2009）
//   - 256 维 Float32 向量（无 GPU，无外部 Embedding API，纯本地）
//   - Tokenize → unigram + bigram → FNV-1a hash → bucket → log-TF 权重 → L2 normalize
//   - sqlite-vec vec0 虚表做 cosine KNN 检索（< 1ms on 10k rows）
//
// Part I 扩展：Voyage AI 真向量嵌入（voyage-3-lite, 512d）
//   - 设置 VOYAGE_API_KEY 后自动启用，无 key 时降级到 Feature Hashing
//   - 独立虚表 memory_vec_voyage（512维），不影响现有 memory_vec（256维）
//
// 优雅降级：sqlite-vec 加载失败时 isVecReady() = false，
//   调用方检测后回退到 confidence 排序（三处 ORDER BY 改动均处理了此情况）
//
// 调用时序：
//   1. initDb()（同步）
//   2. await initVectorStore(getDb())  ← 在 server/v2/app.js 启动时 await
//   3. 之后 indexMemoryEntry / searchSimilarMemory 均同步调用

const DIM = 256; // Feature Hashing 向量维度

// ── Voyage AI 配置（Part I 扩展）───────────────────────────────────
const VOYAGE_API_URL  = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL    = process.env.VOYAGE_MODEL || 'voyage-3-lite';
const VOYAGE_DIM      = 512; // voyage-3-lite 实际输出 512 维（voyage-3 才是 1024d）
const USE_VOYAGE      = !!process.env.VOYAGE_API_KEY;

let _vecReady        = false; // Feature Hashing vec0 ready
let _voyageVecReady  = false; // Voyage vec0 ready

// ── Feature Hashing 工具 ─────────────────────────────────────────

/**
 * FNV-1a 32-bit hash
 * Fowler-Noll-Vo: http://www.isthe.com/chongo/tech/comp/fnv/
 */
function fnv1a(str) {
  let hash = 2166136261; // offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0; // 32-bit FNV prime
  }
  return hash;
}

/**
 * Tokenize 文本（ASCII + CJK 混合）
 * - ASCII: lowercase，split on non-alphanum，过滤 len < 2
 * - CJK: 逐字作 token（中文无空格）
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];

  // 提取 CJK 字符
  const cjkTokens = (text.match(/[一-鿿㐀-䶿]+/g) || [])
    .flatMap(w => [...w]); // 字符串展开为单字

  // ASCII/数字 token
  const asciiTokens = text
    .toLowerCase()
    .replace(/[一-鿿㐀-䶿]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(t => t.length >= 2);

  return [...asciiTokens, ...cjkTokens];
}

/**
 * 将文本转换为 DIM 维 L2-normalized Float32 向量
 * Feature Hashing：token → bucket → log-TF 权重 → L2 normalize
 *
 * @param {string} text
 * @returns {Float32Array}  unit vector（L2 norm ≈ 1，空文本返回零向量）
 */
export function embedText(text) {
  const tokens = tokenize(text);
  const vec = new Float32Array(DIM);

  if (tokens.length === 0) return vec; // 零向量 → distance = max

  // Unigram：log-TF 权重
  const counts = Object.create(null);
  for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
  for (const [token, count] of Object.entries(counts)) {
    vec[fnv1a(token) % DIM] += Math.log1p(count);
  }

  // Bigram（权重 0.5，增强短语级语义）
  for (let i = 0; i < tokens.length - 1; i++) {
    vec[fnv1a(`${tokens[i]}__${tokens[i + 1]}`) % DIM] += 0.5;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) vec[i] /= norm;

  return vec;
}

/** Float32Array → sqlite-vec JSON 字符串格式 */
function vecToJson(vec) {
  return `[${Array.from(vec).join(',')}]`;
}

// ── Voyage AI 嵌入 ────────────────────────────────────────────────

/**
 * 调用 Voyage AI API 获取真向量嵌入（voyage-3-lite, 1024d）
 * 仅在 VOYAGE_API_KEY 已配置时调用
 *
 * @param {string} text
 * @param {'document'|'query'} [inputType='document']
 * @returns {Promise<Float32Array>}
 */
async function embedTextVoyage(text, inputType = 'document') {
  const res = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [text], input_type: inputType }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Voyage API ${res.status}: ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  return new Float32Array(data.data[0].embedding);
}

// ── 初始化 ───────────────────────────────────────────────────────

/**
 * 异步初始化：加载 sqlite-vec 扩展并建立 memory_vec 虚表
 * 在 server 启动后 await 一次（initDb() 之后）
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{ supported: boolean }>}
 */
export async function initVectorStore(db) {
  if (_vecReady) return { supported: true };

  try {
    // ESM 动态 import（sqlite-vec 是 ESM-first，.load() 同步调用 db.loadExtension）
    const { load } = await import('sqlite-vec');
    load(db); // db.loadExtension(getLoadablePath()) —— 同步

    // Schema 迁移（idempotent）
    try { db.prepare('ALTER TABLE project_memory ADD COLUMN embedding BLOB').run(); }
    catch { /* 列已存在 */ }

    // memory_vec 虚表：rowid = project_memory.id
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec
      USING vec0(embedding float[${DIM}])
    `);

    _vecReady = true;
    logger.info(`[vectorStore] sqlite-vec loaded (${DIM}d); memory_vec ready`);

    // Voyage AI 虚表（当 VOYAGE_API_KEY 已配置时）
    if (USE_VOYAGE) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec_voyage
          USING vec0(embedding float[${VOYAGE_DIM}])
        `);
        _voyageVecReady = true;
        logger.info(`[vectorStore] Voyage AI embeddings enabled (${VOYAGE_MODEL}, ${VOYAGE_DIM}d)`);
      } catch (vErr) {
        logger.warn('[vectorStore] memory_vec_voyage init failed:', vErr.message);
      }
    }

    return { supported: true };
  } catch (err) {
    logger.warn('[vectorStore] sqlite-vec init failed, gracefully degrading:', err.message);
    _vecReady = false;
    return { supported: false };
  }
}

/** sqlite-vec 是否已成功加载 */
export function isVecReady() {
  return _vecReady;
}

/** Voyage AI 向量索引是否就绪 */
export function isVoyageReady() {
  return _voyageVecReady;
}

// ── 写入：索引 project_memory 条目 ──────────────────────────────

/**
 * 嵌入一条 project_memory 并写入 memory_vec
 * 幂等（先 DELETE 再 INSERT）；sqlite-vec 未就绪时静默跳过
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ memoryId: number, text: string }} params
 */
export function indexMemoryEntry(db, { memoryId, text }) {
  if (!_vecReady) return;
  try {
    const vecJson = vecToJson(embedText(text));
    db.prepare('DELETE FROM memory_vec WHERE rowid = ?').run(memoryId);
    db.prepare('INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)').run(memoryId, vecJson);
  } catch (err) {
    logger.warn(`[vectorStore] indexMemoryEntry(${memoryId}) failed:`, err.message);
  }
  // 触发 Voyage AI 异步索引（fire-and-forget，不阻塞同步调用方）
  if (_voyageVecReady) {
    indexMemoryEntryVoyage(db, { memoryId, text }).catch(err =>
      logger.warn(`[vectorStore] Voyage index(${memoryId}) failed:`, err.message)
    );
  }
}

/**
 * Voyage AI 异步嵌入 + 写入 memory_vec_voyage
 * @param {import('better-sqlite3').Database} db
 * @param {{ memoryId: number, text: string }} params
 */
export async function indexMemoryEntryVoyage(db, { memoryId, text }) {
  if (!_voyageVecReady) return;
  const vec = await embedTextVoyage(text, 'document');
  const vecJson = vecToJson(vec);
  db.prepare('DELETE FROM memory_vec_voyage WHERE rowid = ?').run(memoryId);
  db.prepare('INSERT INTO memory_vec_voyage(rowid, embedding) VALUES (?, ?)').run(memoryId, vecJson);
}

/**
 * 批量补建缺失向量（启动时运行，补全旧数据）
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [tenantId='default']
 * @returns {{ indexed: number }}
 */
export function rebuildMemoryIndex(db, tenantId = 'default') {
  if (!_vecReady) return { indexed: 0 };
  try {
    const rows = db.prepare(`
      SELECT id, body FROM project_memory
      WHERE tenant_id = ? AND superseded_by IS NULL
    `).all(tenantId);

    let indexed = 0;
    for (const row of rows) {
      const exists = db.prepare('SELECT rowid FROM memory_vec WHERE rowid = ?').get(row.id);
      if (!exists) {
        indexMemoryEntry(db, { memoryId: row.id, text: row.body });
        indexed++;
      }
    }
    if (indexed > 0) logger.info(`[vectorStore] rebuilt ${indexed} missing vectors (tenant=${tenantId})`);
    return { indexed };
  } catch (err) {
    logger.warn('[vectorStore] rebuildMemoryIndex failed:', err.message);
    return { indexed: 0 };
  }
}

// ── 读取：KNN 向量检索 ───────────────────────────────────────────

/**
 * 基于向量相似度检索最相关的 project_memory 条目
 * sqlite-vec 未就绪时返回 null（调用方应回退到 ORDER BY confidence DESC）
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object}   params
 * @param {string}   params.tenantId
 * @param {string}   params.query         - 查询文本（会被 embed）
 * @param {string}   [params.projectId]   - 限定项目（null = 不限）
 * @param {number}   [params.limit=10]    - 返回条数
 * @param {string[]} [params.kinds]       - kind 白名单（空 = 不限）
 * @returns {object[] | null}  project_memory 行（含 _vecDistance）；null = 降级
 */
export function searchSimilarMemory(db, { tenantId, query, projectId, limit = 10, kinds }) {
  if (!_vecReady) return null;

  try {
    const queryJson = vecToJson(embedText(query));

    // 多取 5× 以补偿 tenant/kind 后过滤的损耗
    const knnRows = db.prepare(`
      SELECT rowid, distance
      FROM memory_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(queryJson, limit * 5);

    if (knnRows.length === 0) return [];

    const ids = knnRows.map(r => r.rowid);
    const distMap = new Map(knnRows.map(r => [r.rowid, r.distance]));

    // 回拼 project_memory（按 rowid IN (...)）
    const ph = ids.map(() => '?').join(',');
    let sql = `
      SELECT * FROM project_memory
      WHERE id IN (${ph})
        AND tenant_id = ?
        AND (project_id = ? OR project_id IS NULL)
        AND superseded_by IS NULL
    `;
    const sqlParams = [...ids, tenantId, projectId || ''];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      sqlParams.push(...kinds);
    }

    const rows = db.prepare(sql).all(...sqlParams);

    // 按向量距离升序排（越小越相似）
    rows.sort((a, b) => (distMap.get(a.id) ?? 999) - (distMap.get(b.id) ?? 999));

    return rows.slice(0, limit).map(r => ({
      ...r,
      _vecDistance: distMap.get(r.id) ?? null,
    }));
  } catch (err) {
    logger.warn('[vectorStore] searchSimilarMemory failed, falling back:', err.message);
    return null; // 降级信号
  }
}

/**
 * Voyage AI 版 KNN 检索（语义质量更高，异步）
 * Voyage 未就绪时返回 null，调用方回退到 searchSimilarMemory
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} params  - 与 searchSimilarMemory 相同
 * @returns {Promise<object[] | null>}
 */
export async function searchSimilarMemoryVoyage(db, { tenantId, query, projectId, limit = 10, kinds }) {
  if (!_voyageVecReady) return null;

  try {
    const vec = await embedTextVoyage(query, 'query');
    const queryJson = vecToJson(vec);

    const knnRows = db.prepare(`
      SELECT rowid, distance
      FROM memory_vec_voyage
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(queryJson, limit * 5);

    if (knnRows.length === 0) return [];

    const ids = knnRows.map(r => r.rowid);
    const distMap = new Map(knnRows.map(r => [r.rowid, r.distance]));

    const ph = ids.map(() => '?').join(',');
    let sql = `
      SELECT * FROM project_memory
      WHERE id IN (${ph})
        AND tenant_id = ?
        AND (project_id = ? OR project_id IS NULL)
        AND superseded_by IS NULL
    `;
    const sqlParams = [...ids, tenantId, projectId || ''];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      sqlParams.push(...kinds);
    }
    const rows = db.prepare(sql).all(...sqlParams);
    rows.sort((a, b) => (distMap.get(a.id) ?? 999) - (distMap.get(b.id) ?? 999));
    return rows.slice(0, limit).map(r => ({ ...r, _vecDistance: distMap.get(r.id) ?? null, _source: 'voyage' }));
  } catch (err) {
    logger.warn('[vectorStore] searchSimilarMemoryVoyage failed, falling back:', err.message);
    return null;
  }
}
