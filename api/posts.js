// =====================================================================
// /api/posts  —  노션 데이터베이스를 읽어 뉴스트래킹 JSON을 돌려주는 중계 함수
// 비밀 열쇠(NOTION_TOKEN)는 이 함수만 알고, 사이트에는 노출되지 않습니다.
//
// 필요한 환경변수(Vercel에서 설정): NOTION_TOKEN, NOTION_DB_ID
//
// 읽는 노션 속성(열) 이름 — 데이터베이스에 아래 이름 그대로 있어야 합니다:
//   Title(제목) · Author(사람/선택) · Date of Issue(날짜) ·
//   Content Summary(텍스트) · Insight(텍스트) · Source(URL) ·
//   Tag(다중 선택, 선택사항) · Status(상태) — "홈페이지 게시"인 뉴스만 게시
//
// 인사이트는: Insight 속성에 내용이 있으면 그걸 쓰고,
//            비어 있으면 그 뉴스 페이지 '본문'을 읽어 인사이트로 씁니다.
// =====================================================================

// 아래 값(공백 제거해서 비교)인 뉴스만 사이트에 게시. 값을 바꾸려면 여기만 수정.
const PUBLISH_STATUS = ["홈페이지게시"];
const normStatus = (s) => (s || "").replace(/\s/g, "").toLowerCase();
const NOTION_VERSION = "2022-06-28";

// title / rich_text 속성에서 순수 텍스트만 뽑기
function readText(prop) {
  if (!prop) return "";
  const arr = prop.title || prop.rich_text || [];
  return arr.map((t) => t.plain_text).join("").trim();
}

// 작성자: 사람(people) / 다중선택 / 선택 / 텍스트 무엇이든 처리
function readAuthor(prop) {
  if (!prop) return "";
  if (prop.people) return prop.people.map((x) => x.name).filter(Boolean).join(", ");
  if (prop.multi_select) return prop.multi_select.map((x) => x.name).join(", ");
  if (prop.select) return prop.select.name || "";
  if (prop.rich_text || prop.title) return readText(prop);
  return "";
}

// 상태: 노션 'Status' 타입(status)과 '선택'(select) 둘 다 처리
function readStatus(prop) {
  if (!prop) return "";
  if (prop.status) return prop.status.name || "";
  if (prop.select) return prop.select.name || "";
  return "";
}

// Insight 속성이 실제 내용인지(빈칸이나 'Insight' 같은 라벨이 아닌지) 판단
function meaningfulInsight(s) {
  const t = (s || "").trim().toLowerCase();
  return t.length > 0 && t !== "insight" && t !== "insights";
}

// 뉴스 페이지 본문(블록)을 읽어 인사이트 텍스트로 조립 (소제목 + 문단)
async function readInsightBody(pageId, headers) {
  try {
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, { headers });
    if (!r.ok) return "";
    const d = await r.json();
    const parts = [];
    for (const b of d.results || []) {
      const node = b[b.type];
      const txt = node && node.rich_text ? node.rich_text.map((t) => t.plain_text).join("") : "";
      if (!txt.trim()) continue;
      // 소제목 앞에는 빈 줄을 넣어 문단과 구분
      if (b.type.startsWith("heading")) parts.push((parts.length ? "\n" : "") + txt);
      else parts.push(txt);
    }
    return parts.join("\n");
  } catch (e) {
    return "";
  }
}

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;

  if (!token || !dbId) {
    res.status(500).json({ error: "NOTION_TOKEN / NOTION_DB_ID 환경변수가 설정되지 않았습니다." });
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  try {
    // 노션은 한 번에 최대 100개 → 여러 페이지 이어서 가져오기
    let results = [];
    let cursor = undefined;
    do {
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
      });
      if (!r.ok) {
        const detail = await r.text();
        res.status(500).json({ error: "노션 API 오류 (통합 연결/토큰/DB ID 확인)", detail });
        return;
      }
      const data = await r.json();
      results = results.concat(data.results || []);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    // 각 뉴스 행 → 사이트가 쓰는 형태로 변환
    let posts = await Promise.all(
      results.map(async (page, i) => {
        const p = page.properties || {};
        const status = readStatus(p["Status"]);
        let insight = readText(p["Insight"]);
        if (!meaningfulInsight(insight)) {
          insight = await readInsightBody(page.id, headers); // 본문에서 인사이트 가져오기
        }
        return {
          id: i + 1,
          status,
          title: readText(p["Title"]),
          author: readAuthor(p["Author"]),
          summary: readText(p["Content Summary"]),
          insight,
          source: (p["Source"] && p["Source"].url) || "",
          date: (p["Date of Issue"] && p["Date of Issue"].date && p["Date of Issue"].date.start) || "",
          tags: p["Tag"] && p["Tag"].multi_select ? p["Tag"].multi_select.map((t) => t.name) : [],
        };
      })
    );

    // 제목 있고 + Status가 "홈페이지 게시"인 뉴스만 게시
    posts = posts.filter((x) => x.title && PUBLISH_STATUS.includes(normStatus(x.status)));
    // 최신순 정렬 (날짜 내림차순)
    posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(posts);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
