import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/agentai",
});

// Create the documents table on first startup if it doesn't exist yet.
// This avoids needing a manual migration step during development.
export const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id          UUID        PRIMARY KEY,
      filename    TEXT        NOT NULL,
      file_path   TEXT        NOT NULL,
      status      TEXT        NOT NULL DEFAULT 'processing',
      chunk_count INT,
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  console.log("[db] documents table ready");
};

export default pool;
