// server.js ーー フル版（login + session + admin保護 + ラダーAPI）

const express = require("express");
const path = require("path");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const db = require("./db");

const app = express();

// ==== 安全設定（本番必須） ==========================================
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}

// ==== ミドルウェア ===================================================
app.use(express.json());

// Render 等のLB配下では secure Cookie 判定のため必須
app.set("trust proxy", 1);

app.use(
  session({
    name: "sid",
    secret: process.env.SESSION_SECRET || "dev-session-secret",
    store: new SQLiteStore({
      // 永続ディスク配下に保存（Render の推奨パス）
      dir: process.env.SESSIONS_DIR || "/opt/render/project/data",
      db: "sessions.sqlite", // ファイル名
      // table: 'sessions',   // 変えたい場合だけ
    }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production", // 本番は Secure
      maxAge: 1000 * 60 * 60 * 8, // 8時間
    },
  })
);

// public 配信（index.html, match-log.html, ranking-log.html, styles.css, app.js 等）
app.use(express.static(path.join(__dirname, "public")));

// ==== ユーティリティ =================================================
function fetchLadder(seasonId, tx) {
  const stmt = (tx || db).prepare(`
    SELECT sr.rank, p.id as player_id, p.name
    FROM season_rankings sr
    JOIN players p ON p.id = sr.player_id
    WHERE sr.season_id = ?
    ORDER BY sr.rank ASC
  `);
  return stmt.all(seasonId);
}

function saveLadder(seasonId, ladder, tx) {
  const del = (tx || db).prepare(
    `DELETE FROM season_rankings WHERE season_id = ?`
  );
  del.run(seasonId);
  const ins = (tx || db).prepare(`
    INSERT INTO season_rankings(season_id, rank, player_id) VALUES (?, ?, ?)
  `);
  const insertMany = (tx || db).transaction(() => {
    ladder.forEach((row, idx) => ins.run(seasonId, idx + 1, row.player_id));
  });
  insertMany();
}

function requireAuth(req, res, next) {
  if (req.session?.user?.role === "admin") return next();
  // 未ログインはログイン画面へリダイレクト（UX重視）
  return res.redirect("/login.html");
}

// ---- ranks を 1..K の“詰め”に正規化（dense rank） ----
function densifyRanks(seasonId, tx) {
  const dbi = tx || db;
  const rows = dbi
    .prepare(
      `SELECT DISTINCT rank FROM season_rankings WHERE season_id = ? ORDER BY rank ASC`
    )
    .all(seasonId);
  const map = new Map();
  rows.forEach((r, idx) => map.set(r.rank, idx + 1));
  const upd = dbi.prepare(
    `UPDATE season_rankings SET rank = ? WHERE season_id = ? AND rank = ?`
  );
  dbi.transaction(() => {
    for (const [oldRank, newRank] of map.entries()) {
      if (oldRank !== newRank) upd.run(newRank, seasonId, oldRank);
    }
  })();
}

function ensureInLadder(seasonId, playerId, tx) {
  const dbi = tx || db;
  const exists = dbi
    .prepare(
      `SELECT 1 FROM season_rankings WHERE season_id = ? AND player_id = ?`
    )
    .get(seasonId, playerId);
  if (exists) return;

  const maxRow = dbi
    .prepare(
      `SELECT COALESCE(MAX(rank), 0) AS mx FROM season_rankings WHERE season_id = ?`
    )
    .get(seasonId);
  const insertAt = (maxRow.mx || 0) + 1; // 末尾に追加
  dbi
    .prepare(
      `INSERT INTO season_rankings(season_id, rank, player_id) VALUES (?, ?, ?)`
    )
    .run(seasonId, insertAt, playerId);
}

// ==== ユーティリティ（既存の下あたりに追加） ====
function resolveSeasonId({ season_id, year }) {
  if (season_id) return Number(season_id);
  if (!year) return null;
  const row = db
    .prepare(`SELECT id FROM seasons WHERE year = ?`)
    .get(Number(year));
  return row ? row.id : null;
}

// ==== 認証API =======================================================
// POST /auth/login { username, password }
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ ok: false, error: "missing credentials" });

  const row = db
    .prepare(
      `SELECT id, username, password_hash FROM admins WHERE username = ?`
    )
    .get(username);
  if (!row)
    return res.status(401).json({ ok: false, error: "invalid credentials" });

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok)
    return res.status(401).json({ ok: false, error: "invalid credentials" });

  req.session.user = { id: row.id, username: row.username, role: "admin" };
  res.json({ ok: true, user: { username: row.username } });
});

// POST /auth/logout
app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("sid");
    res.json({ ok: true });
  });
});

// GET /auth/me
app.get("/auth/me", (req, res) => {
  if (req.session?.user) return res.json({ ok: true, user: req.session.user });
  res.json({ ok: false, user: null });
});

// ==== 管理ページ（保護配信） =========================================
// private/admin.html を配信（public には置かない）
app.get("/admin", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "admin.html"));
});

// ==== ラダー初期化 & ランキングAPI ===================================
// POST /init-season { year, playersInOrder: string[] }
app.post("/init-season", (req, res) => {
  const { year, playersInOrder, entries } = req.body || {};
  if (!year) return res.status(400).json({ ok: false, error: "year required" });
  if (!Array.isArray(playersInOrder) && !Array.isArray(entries)) {
    return res
      .status(400)
      .json({ ok: false, error: "playersInOrder or entries required" });
  }

  try {
    let seasonId;
    db.transaction(() => {
      const season = db
        .prepare(`INSERT INTO seasons(year) VALUES(?)`)
        .run(year);
      seasonId = season.lastInsertRowid;

      const upsert = db.prepare(
        `INSERT INTO players(name) VALUES(?) ON CONFLICT(name) DO NOTHING`
      );
      const getId = db.prepare(`SELECT id FROM players WHERE name = ?`);

      if (Array.isArray(entries)) {
        // entries: [{name, rank}]
        for (const e of entries) {
          const name = String(e?.name || "").trim();
          const rnk = Number(e?.rank);
          if (!name || !Number.isFinite(rnk) || rnk < 1) continue;
          upsert.run(name);
          const pid = getId.get(name).id;
          db.prepare(
            `INSERT INTO season_rankings(season_id, rank, player_id) VALUES (?,?,?)`
          ).run(seasonId, rnk, pid);
        }
      } else {
        // playersInOrder: 1..N で保存
        const ladder = [];
        playersInOrder.forEach((raw, i) => {
          const name = String(raw).trim();
          if (!name) return;
          upsert.run(name);
          const pid = getId.get(name).id;
          ladder.push({ player_id: pid, rank: i + 1 });
        });
        const ins = db.prepare(
          `INSERT INTO season_rankings(season_id, rank, player_id) VALUES (?,?,?)`
        );
        ladder.forEach((row) => ins.run(seasonId, row.rank, row.player_id));
      }
    })();

    res.json({ ok: true, season_id: seasonId, year });
  } catch (e) {
    console.error(e);
    res.status(400).json({ ok: false, error: String(e) });
  }
});

// GET /rankings?season_id=1
// GET /rankings?season_id=1  または  /rankings?year=2025
app.get("/rankings", (req, res) => {
  const seasonId = resolveSeasonId({
    season_id: req.query.season_id,
    year: req.query.year,
  });
  if (!seasonId)
    return res
      .status(400)
      .json({ ok: false, error: "season_id or year required" });
  try {
    const data = fetchLadder(seasonId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// POST /matches { season_id, winner_name, loser_name, played_at? }
// 既存 /matches をこの実装に置き換え
// 置き換え：同順位＝敗者のみ+1、下剋上＝勝者を(敗者rank-1)へ、詰め直しナシ
// ランキング更新ルール：
// - 上位が勝つ（wRank < lRank）→ 変動なし
// - 下剋上（wRank > lRank）   → 勝者 rank = max(1, 敗者rank-1)（他は触らない）
// - 同順位（wRank === lRank） → 勝者は同ランク帯の先頭（rank据え置き）／その他(敗者含む)は +1 で繰り下げ
app.post("/matches", (req, res) => {
  const { season_id, winner_name, loser_name, played_at, score, note } =
    req.body || {};
  const seasonId = Number(season_id);
  const wn = String(winner_name || "").trim();
  const ln = String(loser_name || "").trim();
  if (!seasonId || !wn || !ln) {
    return res
      .status(400)
      .json({
        ok: false,
        error: "season_id, winner_name, loser_name required",
      });
  }

  try {
    db.transaction(() => {
      // players upsert
      const upsert = db.prepare(
        `INSERT INTO players(name) VALUES(?) ON CONFLICT(name) DO NOTHING`
      );
      const getId = db.prepare(`SELECT id FROM players WHERE name = ?`);
      [wn, ln].forEach((n) => upsert.run(n));
      const winner_id = getId.get(wn).id;
      const loser_id = getId.get(ln).id;

      // 試合ログ
      db.prepare(
        `
        INSERT INTO matches(season_id, played_at, winner_id, loser_id, score, note, processed)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `
      ).run(
        seasonId,
        played_at || new Date().toISOString(),
        winner_id,
        loser_id,
        score || null,
        note || null
      );

      // ラダーに未登録なら末尾へ（MAX(rank)+1）
      const ensure = (pid) => {
        const ex = db
          .prepare(
            `SELECT 1 FROM season_rankings WHERE season_id = ? AND player_id = ?`
          )
          .get(seasonId, pid);
        if (!ex) {
          const mx = db
            .prepare(
              `SELECT COALESCE(MAX(rank),0) AS mx FROM season_rankings WHERE season_id = ?`
            )
            .get(seasonId).mx;
          db.prepare(
            `INSERT INTO season_rankings(season_id, rank, player_id) VALUES (?,?,?)`
          ).run(seasonId, mx + 1, pid);
        }
      };
      ensure(winner_id);
      ensure(loser_id);

      // 現在のランクを取得
      const rows = db
        .prepare(
          `
        SELECT player_id, rank
        FROM season_rankings
        WHERE season_id = ? AND player_id IN (?,?)
      `
        )
        .all(seasonId, winner_id, loser_id);

      const wRank = rows.find((r) => r.player_id === winner_id).rank;
      const lRank = rows.find((r) => r.player_id === loser_id).rank;

      if (wRank < lRank) {
        // 上位が勝利 → 変動なし
        return;
      } else if (wRank > lRank) {
        // 下剋上 → 勝者を敗者の1つ上へ（他は触らない）
        const newWRank = Math.max(1, lRank - 1);
        db.prepare(
          `UPDATE season_rankings SET rank = ? WHERE season_id = ? AND player_id = ?`
        ).run(newWRank, seasonId, winner_id);
      } else {
        // === 同順位どうし ===
        // 勝者は rank 据え置き（＝そのランク帯の先頭）
        // 同ランク帯の "勝者以外全員" を +1 で繰り下げ（敗者含む）
        db.prepare(
          `
          UPDATE season_rankings
             SET rank = rank + 1
           WHERE season_id = ?
             AND rank = ?
             AND player_id != ?
        `
        ).run(seasonId, wRank, winner_id);
        // 勝者は触らない（そのまま rank=wRank に残る）
      }
    })();

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ ok: false, error: String(e) });
  }
});

// GET /matches?season_id=1  （直近100件）
// GET /matches?season_id=1  または  /matches?year=2025
app.get("/matches", (req, res) => {
  const seasonId = resolveSeasonId({
    season_id: req.query.season_id,
    year: req.query.year,
  });
  if (!seasonId)
    return res
      .status(400)
      .json({ ok: false, error: "season_id or year required" });
  try {
    const rows = db
      .prepare(
        `SELECT m.id, m.played_at, m.score, m.note,
         w.name AS winner, l.name AS loser
         FROM matches m
         JOIN players w ON w.id = m.winner_id
         JOIN players l ON l.id = m.loser_id
         WHERE m.season_id = ?
         ORDER BY datetime(m.played_at) DESC, m.id DESC
         LIMIT 100`
      )
      .all(seasonId);
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ==== 管理API（セッション必須） =====================================
// POST /admin/season/:seasonId/players { name, rank? }  rank=1始まり
// 置き換え: 管理API（同順位対応 / ランク詰め直し込み）
// POST /admin/season/:seasonId/players  { name, rank? }  rankは1始まり（省略で末尾）
app.post("/admin/season/:seasonId/players", requireAuth, (req, res) => {
  const seasonId = Number(req.params.seasonId);
  const nameRaw = String(req.body?.name || "").trim();
  const rankRaw = req.body?.rank;

  if (!seasonId || !nameRaw) {
    return res
      .status(400)
      .json({ ok: false, error: "seasonId and name are required" });
  }

  let existed = false;
  let existingRank = null;
  let playerId = null;
  let finalRank = null;

  try {
    db.transaction(() => {
      // players に upsert
      db.prepare(
        `INSERT INTO players(name) VALUES(?) ON CONFLICT(name) DO NOTHING`
      ).run(nameRaw);
      const player = db
        .prepare(`SELECT id FROM players WHERE name = ?`)
        .get(nameRaw);
      if (!player) throw new Error("failed to upsert player");
      playerId = player.id;

      // 既にこのシーズンのラダーにいる？
      const ex = db
        .prepare(
          `
        SELECT rank FROM season_rankings WHERE season_id = ? AND player_id = ?
      `
        )
        .get(seasonId, playerId);
      if (ex) {
        existed = true;
        existingRank = ex.rank;
        return; // ここで終了（DB変更なし）
      }

      // 追加するrankを決定（省略なら末尾 = MAX(rank)+1）
      const maxRow = db
        .prepare(
          `SELECT COALESCE(MAX(rank), 0) AS mx FROM season_rankings WHERE season_id = ?`
        )
        .get(seasonId);
      let insertRank =
        Number.isFinite(Number(rankRaw)) && Number(rankRaw) >= 1
          ? Number(rankRaw)
          : maxRow.mx + 1;

      // 1レコードだけ追加（同順位OK）
      db.prepare(
        `
        INSERT INTO season_rankings(season_id, rank, player_id) VALUES (?,?,?)
      `
      ).run(seasonId, insertRank, playerId);

      // 詰め直し後の最終rankを取得して返す
      const row = db
        .prepare(
          `
        SELECT rank FROM season_rankings WHERE season_id = ? AND player_id = ?
      `
        )
        .get(seasonId, playerId);
      finalRank = row.rank;
    })();

    if (existed) {
      return res.json({
        ok: true,
        season_id: seasonId,
        player_id: playerId,
        new_rank: existingRank,
        existed: true,
      });
    }
    return res.json({
      ok: true,
      season_id: seasonId,
      player_id: playerId,
      new_rank: finalRank,
      existed: false,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// GET /seasons -> { ok, seasons: [{id, year}] } 年降順
app.get("/seasons", (req, res) => {
  const rows = db
    .prepare(`SELECT id, year FROM seasons ORDER BY year DESC`)
    .all();
  res.json({ ok: true, seasons: rows });
});

// ==== サーバ起動 =====================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
