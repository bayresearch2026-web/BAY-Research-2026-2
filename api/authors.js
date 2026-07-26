// =====================================================================
// /api/authors — 노션 "작성자 소개" 데이터베이스를 읽어 [{name, bio}] 를 돌려주는 중계 함수
//
// 필요한 환경변수(Vercel): NOTION_TOKEN, NOTION_AUTHORS_DB_ID
//   - NOTION_TOKEN 은 기존 것을 그대로 사용 (같은 통합에 이 DB도 "연결"해야 함!)
//   - NOTION_AUTHORS_DB_ID 만 새로 추가
//
// 읽는 속성(열): 이름 = 제목(Title) 속성 아무거나 / 한줄소개 = 텍스트 속성
//   (한줄소개 / 소개 / Bio / 자기소개 라는 이름을 우선 찾고, 없으면 첫 텍스트 열 사용)
//
// 진단: 주소 뒤에 ?debug=1 을 붙이면 설정 상태·행 개수·열 이름·오류를 볼 수 있습니다.
// 환경변수가 없으면 빈 배열([])을 돌려주므로 사이트는 그대로 동작합니다.
// =====================================================================

function readText(prop) {
  if (!prop) return "";
  const arr = prop.title || prop.rich_text || [];
  return arr.map((t) => t.plain_text).join("").trim();
}
function getProp(props, name) {
  if (!props) return null;
  if (props[name]) return props[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(props)) if (k.toLowerCase() === lower) return props[k];
  return null;
}
function firstText(props, names) {
  for (const n of names) {
    const p = getProp(props, n);
    if (p) { const t = readText(p); if (t) return t; }
  }
  return "";
}
// 이름: 지정 이름을 못 찾으면 '제목(title)' 타입 열을 자동으로 사용
function pickName(props) {
  const byName = firstText(props, ["이름", "Name", "작성자", "성함", "팀원", "닉네임"]);
  if (byName) return byName;
  for (const k of Object.keys(props || {})) {
    const p = props[k];
    if (p && p.title) { const t = readText(p); if (t) return t; }
  }
  return "";
}
// 한줄소개: 지정 이름을 못 찾으면 제목이 아닌 첫 텍스트(rich_text) 열을 자동으로 사용
function pickBio(props) {
  const byName = firstText(props, ["한줄소개", "한 줄 소개", "소개", "Bio", "자기소개", "introduction", "한마디"]);
  if (byName) return byName;
  for (const k of Object.keys(props || {})) {
    const p = props[k];
    if (p && p.rich_text && p.rich_text.length) { const t = readText(p); if (t) return t; }
  }
  return "";
}
function headers(token, version) {
  return { Authorization: `Bearer ${token}`, "Notion-Version": version, "Content-Type": "application/json" };
}
async function queryAll(url, token, version) {
  let out = [], cursor;
  do {
    const r = await fetch(url, {
      method: "POST",
      headers: headers(token, version),
      body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!r.ok) { const e = new Error(await r.text()); e.status = r.status; throw e; }
    const d = await r.json();
    out = out.concat(d.results || []);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return out;
}

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_AUTHORS_DB_ID;
  const debug = req.query && (req.query.debug || req.query.debug === "");
  const diag = { token_set: !!token, db_id_set: !!dbId };

  if (!token || !dbId) {
    if (debug) { res.status(200).json({ ...diag, note: "NOTION_TOKEN 또는 NOTION_AUTHORS_DB_ID 환경변수가 없습니다. Vercel에 추가 후 재배포하세요." }); return; }
    res.status(200).json([]);
    return;
  }

  let results = [];
  try {
    // 1) 새 구조: 데이터 소스 조회
    try {
      const dbRes = await fetch(`https://api.notion.com/v1/databases/${dbId}`, { headers: headers(token, "2025-09-03") });
      diag.db_retrieve_status = dbRes.status;
      if (dbRes.ok) {
        const db = await dbRes.json();
        diag.data_sources = (db.data_sources || []).length;
        for (const s of db.data_sources || []) {
          try {
            results = results.concat(await queryAll(`https://api.notion.com/v1/data_sources/${s.id}/query`, token, "2025-09-03"));
          } catch (e) { diag.ds_error = String(e.message || e).slice(0, 200); }
        }
      }
    } catch (e) { diag.retrieve_error = String(e.message || e).slice(0, 200); }

    // 2) 레거시 폴백
    if (results.length === 0) {
      try {
        results = await queryAll(`https://api.notion.com/v1/databases/${dbId}/query`, token, "2022-06-28");
        diag.legacy = true;
      } catch (e) {
        diag.query_error = String(e.message || e).slice(0, 300);
        diag.query_status = e.status || null;
      }
    }

    const authors = results.map((page) => ({ name: pickName(page.properties || {}), bio: pickBio(page.properties || {}) })).filter((a) => a.name);

    if (debug) {
      const first = results[0] && results[0].properties ? Object.keys(results[0].properties) : null;
      res.status(200).json({ ...diag, raw_count: results.length, matched_count: authors.length, first_row_columns: first, sample: authors.slice(0, 5) });
      return;
    }

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(authors);
  } catch (e) {
    if (debug) { res.status(200).json({ ...diag, error: String(e.message || e).slice(0, 300) }); return; }
    res.status(200).json([]);
  }
}
