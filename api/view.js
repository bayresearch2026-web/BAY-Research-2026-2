// =====================================================================
// /api/view  —  글 하나의 "조회수"를 노션 DB에 1 올려주는 중계 함수
//
// 필요한 준비 (딱 두 가지):
//  1) 노션 뉴스트래킹 DB에 "Views" 라는 이름의 숫자(Number) 열을 추가
//  2) 노션 통합(Integration) 설정에서 "콘텐츠 편집(Update content)" 권한을 켜기
//     → 좋아요가 이미 저장되고 있다면 2번은 이미 켜져 있는 상태입니다.
//
// 사용법: POST { pageId: "..." }  →  { views: 1234 }
// 같은 사람이 새로고침해도 오르지 않도록, 하루 1회 제한은 화면(index.html)에서 처리합니다.
//
// 진단: 주소창에 /api/view?debug=1 을 치면 무엇이 막혀 있는지 알려줍니다.
// =====================================================================

const VIEW_PROP = "Views";
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
async function getPage(pageId, token) {
  for (const v of ["2025-09-03", "2022-06-28"]) {
    const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: headers(token, v) });
    if (r.ok) return await r.json();
  }
  return null;
}
function findProp(props, name) {
  if (!props) return [null, null];
  if (props[name]) return [name, props[name]];
  const lower = name.toLowerCase();
  for (const k of Object.keys(props)) if (k.toLowerCase() === lower) return [k, props[k]];
  return [null, null];
}
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
function isPublished(text) {
  const n = normStatus(text);
  return PUBLISH_STATUS.some((s) => n.includes(s));
}

// 진단용: /api/view?debug=1
async function selfCheck(token, dbId) {
  const out = { token: !!token, dbId: !!dbId };
  if (!token || !dbId) { out.결론 = "환경변수(NOTION_TOKEN / NOTION_DB_ID)가 없습니다."; return out; }

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
  } catch (e) { /* 아래 레거시 방식으로 재시도 */ }
  if (!page) {
    const q = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST", headers: headers(token), body: JSON.stringify({ page_size: 100 }),
    });
    if (q.ok) { const d = await q.json(); page = (d.results || [])[0] || null; }
  }
  if (!page) { out.결론 = "DB에서 글을 하나도 읽지 못했습니다. 통합이 이 DB에 연결돼 있는지 확인하세요."; return out; }

  const props = page.properties || {};
  const [viewKey, viewProp] = findProp(props, VIEW_PROP);
  out.속성이름들 = Object.keys(props);
  out.Views열_찾음 = !!viewKey;
  out.Views열_실제이름 = viewKey;
  out.Views열_타입 = viewProp ? viewProp.type : null;

  if (!viewKey) { out.결론 = `DB에 "${VIEW_PROP}" 열이 없습니다. 숫자(Number) 열로 추가하세요.`; return out; }
  if (viewProp.type !== "number") { out.결론 = `"${viewKey}" 열이 숫자(Number) 타입이 아닙니다. 지금 타입: ${viewProp.type}`; return out; }

  // 같은 값을 다시 써서 쓰기 권한만 시험합니다 (값은 바뀌지 않습니다)
  const cur = Number(viewProp.number) || 0;
  const w = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
    method: "PATCH", headers: headers(token),
    body: JSON.stringify({ properties: { [viewKey]: { number: cur } } }),
  });
  out.쓰기권한 = w.ok;
  if (!w.ok) {
    out.쓰기오류 = (await w.text()).slice(0, 300);
    out.결론 = "읽기는 되는데 쓰기가 막혔습니다. 통합 설정에서 'Update content' 권한을 켜세요.";
    return out;
  }
  out.결론 = "모두 정상입니다. 조회수가 올라가야 합니다.";
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

  if (!token) { res.status(500).json({ error: "NOTION_TOKEN 환경변수가 설정되지 않았습니다." }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST 요청만 받습니다." }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const pageId = String(body.pageId || "");
  if (!/^[0-9a-f]{32}$/.test(normId(pageId))) {
    res.status(400).json({ error: "pageId 형식이 올바르지 않습니다." });
    return;
  }

  try {
    const page = await getPage(pageId, token);
    if (!page) { res.status(404).json({ error: "노션 페이지를 찾지 못했습니다." }); return; }
    const props = page.properties || {};

    // 우리 DB 소속이거나 게시 상태이면 통과 (좋아요와 동일한 검사)
    const parent = page.parent || {};
    const inOurDb = !!normId(parent.database_id) && normId(parent.database_id) === normId(process.env.NOTION_DB_ID);
    const [, statusProp] = findProp(props, "Status");
    if (!inOurDb && !isPublished(readStatus(statusProp))) {
      res.status(403).json({ error: "게시된 글이 아닙니다." });
      return;
    }

    const [viewKey, viewProp] = findProp(props, VIEW_PROP);
    if (!viewKey || typeof viewProp.number === "undefined") {
      res.status(400).json({ error: `노션 DB에 "${VIEW_PROP}" 숫자(Number) 열을 먼저 추가해주세요.` });
      return;
    }

    const next = (Number(viewProp.number) || 0) + 1;

    let w = null, detail = "";
    for (const v of ["2025-09-03", "2022-06-28"]) {
      w = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: headers(token, v),
        body: JSON.stringify({ properties: { [viewKey]: { number: next } } }),
      });
      if (w.ok) break;
      detail = (await w.text()).slice(0, 300);
    }
    if (!w.ok) {
      res.status(502).json({
        error: "노션에 저장하지 못했습니다. 통합 설정에서 '콘텐츠 편집' 권한을 확인해주세요.",
        detail,
      });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ views: next });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 300) });
  }
}
