// =====================================================================
// /api/like  —  글 하나의 "좋아요" 수를 노션 DB에 올리고 내리는 중계 함수
//
// 필요한 준비 (딱 두 가지):
//  1) 노션 뉴스트래킹 DB에 "Likes" 라는 이름의 숫자(Number) 열을 추가
//  2) 노션 통합(Integration) 설정에서 "콘텐츠 편집(Update content)" 권한을 켜기
//     → 이게 꺼져 있으면 읽기는 되지만 좋아요 저장이 안 됩니다.
//
// 사용법: POST { pageId: "...", delta: 1 또는 -1 }  →  { likes: 12 }
// 비밀 열쇠(NOTION_TOKEN)는 이 함수만 알고, 사이트에는 노출되지 않습니다.
// =====================================================================

const LIKE_PROP = "Likes";
const PUBLISH_STATUS = ["홈페이지게시"];
const normStatus = (s) => (s || "").replace(/\s/g, "").toLowerCase();
const normId = (s) => String(s || "").replace(/-/g, "").toLowerCase();

function headers(token, version) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": version || "2022-06-28",
    "Content-Type": "application/json",
  };
}
// 페이지 한 건 읽기 — 새 구조(데이터 소스)와 옛 구조를 모두 시도합니다
async function getPage(pageId, token) {
  for (const v of ["2025-09-03", "2022-06-28"]) {
    const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: headers(token, v) });
    if (r.ok) return await r.json();
  }
  return null;
}
// 속성 이름을 대소문자 무시하고 찾아 [실제이름, 값] 으로 돌려줍니다
function findProp(props, name) {
  if (!props) return [null, null];
  if (props[name]) return [name, props[name]];
  const lower = name.toLowerCase();
  for (const k of Object.keys(props)) if (k.toLowerCase() === lower) return [k, props[k]];
  return [null, null];
}
// posts.js 와 똑같이 읽어야 판정이 어긋나지 않습니다 (multi_select·formula 포함)
function readStatus(prop) {
  if (!prop) return "";
  if (prop.status) return prop.status.name || "";
  if (prop.select) return prop.select.name || "";
  if (prop.multi_select) return prop.multi_select.map((x) => x.name).join(", ");
  if (prop.formula) return prop.formula.string || String(prop.formula.number ?? "");
  const arr = prop.rich_text || prop.title;
  if (arr) return arr.map((t) => t.plain_text).join("").trim();
  return "";
}
// 여러 값이 섞여 있어도(예: "홈페이지 게시, 작성완료") 게시 상태를 알아봅니다
function isPublished(text) {
  const n = normStatus(text);
  return PUBLISH_STATUS.some((s) => n.includes(s));
}

// 진단용: /api/like?debug=1 을 주소창에 치면 무엇이 막혀 있는지 알려줍니다
async function selfCheck(token, dbId) {
  const out = { token: !!token, dbId: !!dbId, steps: [] };
  if (!token || !dbId) { out.결론 = "환경변수(NOTION_TOKEN / NOTION_DB_ID)가 없습니다."; return out; }

  // 게시된 글 한 건 찾기 (신 구조 → 구 구조 순서로 시도)
  let page = null;
  try {
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2025-09-03" },
    });
    if (dbRes.ok) {
      const db = await dbRes.json();
      for (const s of db.data_sources || []) {
        const q = await fetch(`https://api.notion.com/v1/data_sources/${s.id}/query`, {
          method: "POST",
          headers: { ...headers(token), "Notion-Version": "2025-09-03" },
          body: JSON.stringify({ page_size: 100 }),
        });
        if (q.ok) { const d = await q.json(); if ((d.results || []).length) { page = d.results[0]; break; } }
      }
    }
  } catch (e) { out.steps.push("신 구조 조회 실패: " + String(e).slice(0, 120)); }
  if (!page) {
    const q = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ page_size: 100 }),
    });
    if (q.ok) { const d = await q.json(); page = (d.results || [])[0] || null; }
  }
  if (!page) { out.결론 = "DB에서 글을 하나도 읽지 못했습니다. 통합이 이 DB에 연결돼 있는지 확인하세요."; return out; }

  const props = page.properties || {};
  out.속성이름들 = Object.keys(props);
  const [statusKey, statusProp] = findProp(props, "Status");
  out.Status열_실제이름 = statusKey;
  out.Status열_타입 = statusProp ? statusProp.type : null;
  out.Status에서_읽은값 = readStatus(statusProp);
  out.게시상태로_인정됨 = isPublished(out.Status에서_읽은값);
  out.부모타입 = (page.parent || {}).type || null;
  out.우리DB소속 = normId((page.parent || {}).database_id) === normId(dbId);
  const [likeKey, likeProp] = findProp(props, LIKE_PROP);
  out.Likes열_찾음 = !!likeKey;
  out.Likes열_실제이름 = likeKey;
  out.Likes열_타입 = likeProp ? likeProp.type : null;

  if (!likeKey) { out.결론 = `DB에 "${LIKE_PROP}" 열이 없습니다. 숫자(Number) 열로 추가하세요.`; return out; }
  if (likeProp.type !== "number") { out.결론 = `"${likeKey}" 열이 숫자(Number) 타입이 아닙니다. 지금 타입: ${likeProp.type}`; return out; }

  // 같은 값을 다시 써서 쓰기 권한만 시험합니다 (값은 바뀌지 않습니다)
  const cur = Number(likeProp.number) || 0;
  const w = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
    method: "PATCH", headers: headers(token),
    body: JSON.stringify({ properties: { [likeKey]: { number: cur } } }),
  });
  out.쓰기권한 = w.ok;
  if (!w.ok) {
    out.쓰기오류 = (await w.text()).slice(0, 300);
    out.결론 = "읽기는 되는데 쓰기가 막혔습니다. 통합 설정에서 'Update content' 권한을 켜세요.";
    return out;
  }
  out.결론 = "모두 정상입니다. 좋아요가 저장돼야 합니다.";
  return out;
}

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;

  if (req.method === "GET" && req.query && (req.query.debug || req.query.debug === "")) {
    res.setHeader("Cache-Control", "no-store");
    try { res.status(200).json(await selfCheck(token, process.env.NOTION_DB_ID)); }
    catch (e) { res.status(500).json({ error: String(e).slice(0, 300) }); }
    return;
  }

  if (!token) {
    res.status(500).json({ error: "NOTION_TOKEN 환경변수가 설정되지 않았습니다." });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST 요청만 받습니다." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const pageId = String(body.pageId || "");
  const delta = body.delta === -1 ? -1 : 1;
  if (!/^[0-9a-f]{32}$/.test(normId(pageId))) {
    res.status(400).json({ error: "pageId 형식이 올바르지 않습니다." });
    return;
  }

  try {
    // 1) 지금 값 읽기 + 이 페이지가 우리 뉴스트래킹 DB의 글이 맞는지 확인
    const page = await getPage(pageId, token);
    if (!page) {
      res.status(404).json({ error: "노션 페이지를 찾지 못했습니다." });
      return;
    }
    const props = page.properties || {};

    // 우리 DB 소속이거나, 게시 상태이면 통과시킵니다 (둘 중 하나만 맞으면 됨)
    const parent = page.parent || {};
    const inOurDb = !!normId(parent.database_id) && normId(parent.database_id) === normId(process.env.NOTION_DB_ID);
    const [, statusProp] = findProp(props, "Status");
    const statusText = readStatus(statusProp);
    if (!inOurDb && !isPublished(statusText)) {
      res.status(403).json({
        error: "게시된 글이 아닙니다.",
        detail: `Status에서 읽은 값: "${statusText}" / 부모: ${parent.type || "알수없음"}`,
      });
      return;
    }

    const [likeKey, likeProp] = findProp(props, LIKE_PROP);
    if (!likeKey || typeof likeProp.number === "undefined") {
      res.status(400).json({
        error: `노션 DB에 "${LIKE_PROP}" 숫자(Number) 열을 먼저 추가해주세요.`,
      });
      return;
    }

    const current = Number(likeProp.number) || 0;
    const next = Math.max(0, current + delta);

    // 2) 새 값 쓰기 (새 구조 → 옛 구조 순으로 시도)
    let w = null, detail = "";
    for (const v of ["2025-09-03", "2022-06-28"]) {
      w = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: headers(token, v),
        body: JSON.stringify({ properties: { [likeKey]: { number: next } } }),
      });
      if (w.ok) break;
      detail = (await w.text()).slice(0, 300);
    }
    if (!w.ok) {
      res.status(502).json({
        error: "노션에 저장하지 못했습니다. 통합 설정에서 '콘텐츠 편집' 권한이 켜져 있는지 확인해주세요.",
        detail,
      });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ likes: next });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
}
