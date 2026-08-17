// Arquivo didatico: cria e atualiza o banco SQLite usado pela rede social.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';


// Abre o arquivo do banco, ativa chaves estrangeiras e garante que as tabelas existam.
export function createDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });

  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  initializeSchema(db);
  return db;
}


// Define as tabelas principais: usuarios, posts, imagens, curtidas, mensagens, chamadas e moderacao.
function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher', 'admin')),
      password_hash TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      banner_url TEXT NOT NULL DEFAULT '',
      suspended_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, following_id),
      CHECK (follower_id <> following_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      parent_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      repost_of_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      delete_reason TEXT,
      CHECK (body IS NOT NULL OR repost_of_id IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS post_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      alt_text TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS likes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, post_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deletion_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS voice_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'active', 'ended', 'declined', 'missed')),
      kind TEXT NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio', 'video')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      answered_at TEXT,
      ended_at TEXT,
      ended_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      CHECK (caller_id <> recipient_id)
    );

    CREATE TABLE IF NOT EXISTS voice_call_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id INTEGER NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('offer', 'answer', 'candidate')),
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts(author_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);
    CREATE INDEX IF NOT EXISTS idx_posts_repost ON posts(repost_of_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_post_media_post_position ON post_media(post_id, position);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_calls_caller_status ON voice_calls(caller_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_calls_recipient_status ON voice_calls(recipient_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_call_signals_call_id ON voice_call_signals(call_id, id);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deletion_requests_status ON deletion_requests(status, created_at DESC);
  `);
  migratePostsForMedia(db);
  migrateVoiceCallsForVideo(db);
}


// Migra bancos antigos para permitir posts com imagem mesmo quando o texto estiver vazio.
function migratePostsForMedia(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'posts'").get();
  if (!row?.sql?.includes('length(trim(body)) > 0')) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE posts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      parent_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      repost_of_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      delete_reason TEXT,
      CHECK (body IS NOT NULL OR repost_of_id IS NOT NULL)
    );
    INSERT INTO posts_new (id, author_id, body, parent_id, repost_of_id, created_at, deleted_at, deleted_by, delete_reason)
      SELECT id, author_id, body, parent_id, repost_of_id, created_at, deleted_at, deleted_by, delete_reason FROM posts;
    DROP TABLE posts;
    ALTER TABLE posts_new RENAME TO posts;
    COMMIT;
    PRAGMA foreign_keys = ON;

    CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts(author_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);
    CREATE INDEX IF NOT EXISTS idx_posts_repost ON posts(repost_of_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
  `);
}
// Migra bancos antigos para diferenciar chamada de voz e chamada de video.
function migrateVoiceCallsForVideo(db) {
  const columns = db.prepare("PRAGMA table_info(voice_calls)").all();
  if (columns.some((column) => column.name === 'kind')) return;

  db.exec("ALTER TABLE voice_calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio', 'video'));");
}
