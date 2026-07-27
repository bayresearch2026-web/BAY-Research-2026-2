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

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
}
// 속성 이름을 대소문자 무시하고 찾아 [실제이름, 값] 으로 돌려줍니다
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
  const arr = prop.rich_text || prop.title;
  if (arr) return arr.map((t) => t.plain_text).join("").trim();
  return "";
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
    // 1) 지금 값 읽기 + 이 페이지가 실제로 게시된 뉴스인지 확인
    const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: headers(token) });
    if (!r.ok) {
      res.status(r.status === 404 ? 404 : 502).json({ error: "노션 페이지를 찾지 못했습니다." });
      return;
    }
    const page = await r.json();
    const props = page.properties || {};

    const [, statusProp] = findProp(props, "Status");
    if (!PUBLISH_STATUS.includes(normStatus(readStatus(statusProp)))) {
      res.status(403).json({ error: "게시된 글이 아닙니다." });
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

    // 2) 새 값 쓰기
    const w = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({ properties: { [likeKey]: { number: next } } }),
    });
    if (!w.ok) {
      const detail = (await w.text()).slice(0, 300);
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
