import pool from "./postgres.js";

export const insertDocument = async (id, filename, filePath) => {
  const { rows } = await pool.query(
    `INSERT INTO documents (id, filename, file_path, status)
     VALUES ($1, $2, $3, 'processing')
     RETURNING *`,
    [id, filename, filePath]
  );
  return rows[0];
};

export const markReady = async (id, chunkCount) => {
  await pool.query(
    `UPDATE documents SET status = 'ready', chunk_count = $2 WHERE id = $1`,
    [id, chunkCount]
  );
};

export const markFailed = async (id, error) => {
  await pool.query(
    `UPDATE documents SET status = 'failed', error = $2 WHERE id = $1`,
    [id, error]
  );
};

export const findDocument = async (id) => {
  const { rows } = await pool.query(
    `SELECT * FROM documents WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
};

export const findDocumentByFilename = async (filename) => {
  const { rows } = await pool.query(
    `SELECT * FROM documents WHERE filename = $1 ORDER BY created_at DESC LIMIT 1`,
    [filename]
  );
  return rows[0] || null;
};

// Reset a document for re-ingestion (e.g. its vectors went missing).
export const markProcessing = async (id) => {
  await pool.query(
    `UPDATE documents SET status = 'processing', chunk_count = NULL, error = NULL WHERE id = $1`,
    [id]
  );
};

export const listDocumentsByStatus = async (status) => {
  const { rows } = await pool.query(
    `SELECT * FROM documents WHERE status = $1 ORDER BY created_at`,
    [status]
  );
  return rows;
};
