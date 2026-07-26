// =====================================================================
// /api/authors — 노션 "작성자 소개" 데이터베이스를 읽어 [{name, bio}] 를 돌려주는 중계 함수
//
// 필요한 환경변수(Vercel): NOTION_TOKEN, NOTION_AUTHORS_DB_ID
//   - NOTION_TOKEN 은 기존 것을 그대로 사용 (같은 통합에 이 DB도 연결하면 됨)
//   - NOTION_AUTHORS_DB_ID 만 새로 추가
//
// 읽는 속성(열) 이름(대소문자·공백 무시):
//   이름  : 이름 / Name / 작성자 / 성함   (제목 속성)
//   한줄소개: 한줄소개 / 소개 / Bio / 자기소개 / 한 줄 소개   (텍스트 속성)
//
// ▶ 환경변수가 없으면 빈 배열([])을 돌려주므로 사이트는 그대로 동작합니다.
// ▶ 새/구 노션 구조(데이터 소스)를 모두 지원합니다.
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
    if (p) {
      const t = readText(p);
      if (t) return t;
    }
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
  // 아직 설정 전이면 빈 배열 -> 사이트는 소개 없이 정상 동작
  if (!token || !dbId) { res.status(200).json([]); return; }

  let results = [];
  try {
    // 1) 새 구조: 데이터 소스 조회
    try {
      const dbRes = await fetch(`https://api.notion.com/v1/databases/${dbId}`, { headers: headers(token, "2025-09-03") });
      if (dbRes.ok) {
        const db = await dbRes.json();
        for (const s of db.data_sources || []) {
          try {
            results = results.concat(await queryAll(`https://api.notion.com/v1/data_sources/${s.id}/query`, token, "2025-09-03"));
          } catch (e) {}
        }
      }
    } catch (e) {}

    // 2) 레거시 폴백
    if (results.length === 0) {
      results = await queryAll(`https://api.notion.com/v1/databases/${dbId}/query`, token, "2022-06-28");
    }

    const authors = results
      .map((page) => {
        const p = page.properties || {};
        return {
          name: firstText(p, ["이름", "Name", "작성자", "성함", "이름 "]),
          bio: firstText(p, ["한줄소개", "한 줄 소개", "소개", "Bio", "자기소개", "introduction"]),
        };
      })
      .filter((a) => a.name);

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(authors);
  } catch (e) {
    // 오류가 나도 사이트가 깨지지 않게 빈 배열
    res.status(200).json([]);
  }
}
