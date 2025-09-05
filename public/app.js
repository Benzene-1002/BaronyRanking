// /public/app.js
const $ = (id) => document.getElementById(id);
const on = (id, type, handler) => {
  const el = $(id);
  if (el) el.addEventListener(type, handler);
};

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        m
      ])
  );
}

function renderTable(rows) {
  const th = `<tr><th>順位</th><th>選手</th><th>player_id</th></tr>`;
  const trs = rows
    .map(
      (r) =>
        `<tr><td>${r.rank}</td><td>${escapeHtml(r.name)}</td><td>${
          r.player_id
        }</td></tr>`
    )
    .join("");
  return `<table>${th}${trs}</table>`;
}

// season_id を入力欄 or localStorage から取得（無ければ 1）
function getSeasonId() {
  const fromInput = Number($("seasonId")?.value);
  const fromStorage = Number(localStorage.getItem("seasonId"));
  if (Number.isFinite(fromInput) && fromInput > 0) return fromInput;
  if (Number.isFinite(fromStorage) && fromStorage > 0) return fromStorage;
  return 1;
}

document.addEventListener("DOMContentLoaded", () => {
  // ▼ 年セレクトを初期化
  async function initSeasonYearSelect() {
    const sel = document.getElementById("seasonYear");
    if (!sel) return; // このページに年セレクトが無ければ何もしない

    try {
      const res = await fetch("/seasons");
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.seasons)) return;

      const saved = localStorage.getItem("seasonYear");
      sel.innerHTML = data.seasons
        .map(
          (s) =>
            `<option value="${s.year}" ${
              String(s.year) === saved ? "selected" : ""
            }>${s.year}</option>`
        )
        .join("");

      // 保存が未設定なら最新年（先頭）を保存
      if (!saved && data.seasons.length > 0) {
        localStorage.setItem("seasonYear", String(data.seasons[0].year));
      }

      // 変更時に保存
      sel.addEventListener("change", () => {
        localStorage.setItem("seasonYear", sel.value);
      });
    } catch (e) {
      console.error("initSeasonYearSelect failed", e);
    }
  }

  initSeasonYearSelect();

  // 起動時に保存済み seasonId を表示欄へ反映
  const saved = localStorage.getItem("seasonId");
  if (saved && $("seasonId")) $("seasonId").value = saved;

  // 1) シーズン初期化
  on("btnInit", "click", async () => {
    const year = Number($("year")?.value);
    const raw = $("players")?.value?.trim() ?? "";
    const playersInOrder = raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const res = await fetch("/init-season", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year, playersInOrder }),
      });
      const data = await res.json();
      if (data.ok) {
        if ($("initMsg")) {
          $(
            "initMsg"
          ).innerHTML = `<span class="ok">OK</span> 作成された season_id: <b>${
            data.season_id ?? "(1の可能性が高い)"
          }</b>`;
        }
        // 返ってきた season_id を保存＆表示欄へ反映（欄があれば）
        if (data.season_id) {
          localStorage.setItem("seasonId", String(data.season_id));
          if ($("seasonId")) $("seasonId").value = data.season_id;
        }
      } else {
        if ($("initMsg"))
          $("initMsg").innerHTML = `<span class="err">Error:</span> ${
            data.error || "unknown error"
          }`;
      }
    } catch (e) {
      if ($("initMsg"))
        $("initMsg").innerHTML = `<span class="err">${e}</span>`;
    }
  });

  // 2) ランキング取得
  on("btnFetch", "click", async () => {
    const sel = document.getElementById("seasonYear");
    const year = sel ? Number(sel.value) : undefined;

    const seasonIdInput = document.getElementById("seasonId"); // 互換のため
    const season_id =
      !year && seasonIdInput ? Number(seasonIdInput.value) : undefined;

    // 保存（yearがあれば優先）
    if (year) localStorage.setItem("seasonYear", String(year));

    const param = year
      ? `year=${year}`
      : season_id
      ? `season_id=${season_id}`
      : "";
    if (!param) {
      if ($("rankArea"))
        $("rankArea").innerHTML = `<span class="err">年が未選択です</span>`;
      return;
    }

    try {
      const res = await fetch(`/rankings?${param}`);
      const rows = await res.json();
      if (!Array.isArray(rows)) {
        if ($("rankArea"))
          $("rankArea").innerHTML = `<span class="err">取得失敗</span>`;
        return;
      }
      if ($("rankArea")) $("rankArea").innerHTML = renderTable(rows);
    } catch (e) {
      if ($("rankArea"))
        $("rankArea").innerHTML = `<span class="err">${e}</span>`;
    }
  });

  // 3) 試合登録
  on("btnMatch", "click", async () => {
    const season_id = getSeasonId();
    localStorage.setItem("seasonId", String(season_id));

    const winner_name = $("winner")?.value.trim();
    const loser_name = $("loser")?.value.trim();
    const played_at = $("playedAt")?.value.trim() || undefined;
    const score = $("score")?.value.trim() || undefined; // ★追加
    const note = $("note")?.value.trim() || undefined; // ★追加

    try {
      const res = await fetch("/matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          season_id,
          winner_name,
          loser_name,
          played_at,
          score,
          note,
        }), // ★追加
      });
      const data = await res.json();
      if (data.ok) {
        if ($("matchMsg"))
          $("matchMsg").innerHTML = `<span class="ok">登録成功</span>`;
        if ($("btnFetch")) $("btnFetch").click(); // ランキング更新
        // 入力クリア（任意）
        if ($("score")) $("score").value = "";
        if ($("note")) $("note").value = "";
      } else {
        if ($("matchMsg"))
          $("matchMsg").innerHTML = `<span class="err">Error:</span> ${
            data.error || "unknown error"
          }`;
      }
    } catch (e) {
      if ($("matchMsg"))
        $("matchMsg").innerHTML = `<span class="err">${e}</span>`;
    }
  });

  // 4) 試合一覧（match-log.html 用）
  on("btnLoadMatches", "click", async () => {
    const sel = document.getElementById("seasonYear");
    const year = sel ? Number(sel.value) : undefined;

    const seasonIdInput = document.getElementById("seasonId"); // 互換
    const season_id =
      !year && seasonIdInput ? Number(seasonIdInput.value) : undefined;

    if (year) localStorage.setItem("seasonYear", String(year));

    const param = year
      ? `year=${year}`
      : season_id
      ? `season_id=${season_id}`
      : "";
    if (!param) {
      if ($("matchList"))
        $("matchList").innerHTML = `<span class="err">年が未選択です</span>`;
      return;
    }

    try {
      const res = await fetch(`/matches?${param}`);
      const data = await res.json();

      if (data.ok && Array.isArray(data.rows)) {
        if (data.rows.length === 0) {
          if ($("matchList"))
            $("matchList").innerHTML = "<small>データがありません</small>";
          return;
        }
        const rows = data.rows
          .map(
            (r) =>
              `<tr>
                <td>${new Date(r.played_at).toLocaleString("ja-JP")}</td>
                <td>${escapeHtml(r.winner)}</td>
                <td>${escapeHtml(r.loser)}</td>
                <td>${r.score ? escapeHtml(r.score) : "-"}</td>
                <td>${r.note ? escapeHtml(r.note) : "-"}</td>
              </tr>`
          )
          .join("");

        if ($("matchList")) {
          $("matchList").innerHTML = `<table>
       <tr><th>日時</th><th>勝者</th><th>敗者</th><th>スコア</th><th>備考</th></tr>
       ${rows}
     </table>`;
        }
      } else {
        if ($("matchList"))
          $("matchList").innerHTML = `<span class="err">取得失敗</span>`;
      }
    } catch (e) {
      if ($("matchList"))
        $("matchList").innerHTML = `<span class="err">${e}</span>`;
    }
  });

  // ▼ admin: 選手追加（先頭/末尾/指定順位）
  on("insertMode", "change", () => {
    const mode = document.getElementById("insertMode")?.value;
    const rankInput = document.getElementById("insertRank");
    if (!rankInput) return;
    rankInput.disabled = mode !== "rank";
  });

  on("btnAddPlayer", "click", async () => {
    const season_id = getSeasonId();
    localStorage.setItem("seasonId", String(season_id));

    const name = document.getElementById("newPlayerName")?.value?.trim();
    const mode = document.getElementById("insertMode")?.value || "bottom";
    const rankRaw = document.getElementById("insertRank")?.value;
    const token =
      document.getElementById("adminToken")?.value?.trim() || "dev-token";

    if (!name) {
      if ($("addPlayerMsg"))
        $(
          "addPlayerMsg"
        ).innerHTML = `<span class="err">選手名を入力してください</span>`;
      return;
    }

    // rank を決定
    let rank = undefined;
    if (mode === "top") rank = 1;
    if (mode === "rank") {
      const n = Number(rankRaw);
      if (Number.isFinite(n) && n > 0) rank = n;
    }

    try {
      const res = await fetch(`/admin/season/${season_id}/players`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Token": token,
        },
        body: JSON.stringify({ name, rank }),
      });
      const data = await res.json();
      if (data.ok) {
        const existed = data.existed ? "（既に登録済み）" : "";
        if ($("addPlayerMsg"))
          $(
            "addPlayerMsg"
          ).innerHTML = `<span class="ok">OK</span> ${escapeHtml(
            name
          )} を順位 ${data.new_rank} に配置 ${existed}`;
        // ランキングが見えるページなら即更新
        if ($("btnFetch")) $("btnFetch").click();
        // 入力クリア（任意）
        if (!data.existed) {
          if ($("newPlayerName")) $("newPlayerName").value = "";
        }
      } else {
        if ($("addPlayerMsg"))
          $("addPlayerMsg").innerHTML = `<span class="err">Error:</span> ${
            data.error || "unknown error"
          }`;
      }
    } catch (e) {
      if ($("addPlayerMsg"))
        $("addPlayerMsg").innerHTML = `<span class="err">${e}</span>`;
    }
  });

  // ▼ ログイン
  on("btnLogin", "click", async () => {
    const username = document.getElementById("loginUser")?.value?.trim();
    const password = document.getElementById("loginPass")?.value ?? "";
    if (!username || !password) {
      if ($("loginMsg"))
        $("loginMsg").innerHTML = `<span class="err">入力してください</span>`;
      return;
    }
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.ok) {
        // 管理ページへ
        window.location.href = "/admin";
      } else {
        if ($("loginMsg"))
          $("loginMsg").innerHTML = `<span class="err">${
            data.error || "ログイン失敗"
          }</span>`;
      }
    } catch (e) {
      if ($("loginMsg"))
        $("loginMsg").innerHTML = `<span class="err">${e}</span>`;
    }
  });

  // ▼ ログアウト
  on("btnLogout", "click", async () => {
    try {
      await fetch("/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login.html";
    }
  });

  // rank,name をパースして /init-season へ entries で送る
  on("btnInitEntries", "click", async () => {
    const year = Number(document.getElementById("year2")?.value);
    const raw = document.getElementById("entries")?.value || "";
    const lines = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const entries = [];
    for (const line of lines) {
      // 例: "1,山田" / "1 , 山田"
      const m = line.split(",").map((x) => x.trim());
      if (m.length >= 2) {
        const rank = Number(m[0]);
        const name = m.slice(1).join(","); // 名前にカンマが含まれても対応
        if (Number.isFinite(rank) && rank >= 1 && name) {
          entries.push({ rank, name });
        }
      }
    }
    if (!year || entries.length === 0) {
      if ($("initMsg2"))
        $(
          "initMsg2"
        ).innerHTML = `<span class="err">年と entries を確認してください</span>`;
      return;
    }

    try {
      const res = await fetch("/init-season", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year, entries }),
      });
      const data = await res.json();
      if (data.ok) {
        if ($("initMsg2"))
          $(
            "initMsg2"
          ).innerHTML = `<span class="ok">OK</span> season_id: <b>${data.season_id}</b>`;
        localStorage.setItem("seasonId", String(data.season_id));
        if ($("seasonId")) $("seasonId").value = data.season_id;
      } else {
        if ($("initMsg2"))
          $("initMsg2").innerHTML = `<span class="err">${
            data.error || "unknown error"
          }</span>`;
      }
    } catch (e) {
      if ($("initMsg2"))
        $("initMsg2").innerHTML = `<span class="err">${e}</span>`;
    }
  });

  // ページに応じて自動ロード
  if ($("rankArea") && $("btnFetch")) $("btnFetch").click();
  if ($("matchList") && $("btnLoadMatches")) $("btnLoadMatches").click();

  // ダミーの # リンクがある場合の遷移抑止（任意）
  document.querySelectorAll('a[href="#"]').forEach((a) => {
    a.addEventListener("click", (e) => e.preventDefault());
  });
});
