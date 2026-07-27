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

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
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
