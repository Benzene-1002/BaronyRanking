// db.js
const Database = require("better-sqlite3");
const path = require("path");

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, "ladder.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS season_rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  UNIQUE(season_id, player_id),
  FOREIGN KEY(season_id) REFERENCES seasons(id) ON DELETE CASCADE,
  FOREIGN KEY(player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL,
  played_at TEXT NOT NULL,
  winner_id INTEGER NOT NULL,
  loser_id INTEGER NOT NULL,
  score     TEXT,                    -- ★追加
  note      TEXT,                    -- ★追加
  processed INTEGER DEFAULT 1,
  FOREIGN KEY(season_id) REFERENCES seasons(id) ON DELETE CASCADE,
  FOREIGN KEY(winner_id) REFERENCES players(id),
  FOREIGN KEY(loser_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

module.exports = db;
