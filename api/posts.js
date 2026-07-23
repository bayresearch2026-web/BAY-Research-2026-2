// =====================================================================
// /api/posts  —  노션 데이터베이스를 읽어 뉴스트래킹 JSON을 돌려주는 중계 함수
// 비밀 열쇠(NOTION_TOKEN)는 이 함수만 알고, 사이트에는 노출되지 않습니다.
//
// 필요한 환경변수(Vercel): NOTION_TOKEN, NOTION_DB_ID
//
// 노션 신/구 구조(데이터 소스)를 모두 지원합니다.
// 읽는 속성(열) 이름: Title · Author · Date of Issue · Content Summary ·
//                    Insight · Source · Tag(선택) · Status
// Status가 "홈페이지 게시"인 뉴스만 사이트에 게시됩니다.
// 진단: 주소 뒤에 ?debug=1 을 붙이면 원본 개수/상태값을 확인할 수 있습니다.
// =====================================================================

const PUBLISH_STATUS = ["홈페이지게시"]; // 공백 제거·소문자 비교
const normStatus = (s) => (s || "").replace(/\s/g, "").toLowerCase();

function readText(prop) {
  if (!prop) return "";
  const arr = prop.title || prop.rich_text || [];
  return arr.map((t) => t.plain_text).join("").trim();
}
// 속성 이름을 대소문자 무시하고 찾기 (예: "Date of Issue" vs "Date of issue")
function getProp(props, name) {
  if (!props) return null;
  if (props[name]) return props[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(props)) if (k.toLowerCase() === lower) return props[k];
  return null;
}
function readAuthor(prop) {
  if (!prop) return "";
  if (prop.people) return prop.people.map((x) => x.name).filter(Boolean).join(", ");
  if (prop.multi_select) return prop.multi_select.map((x) => x.name).join(", ");
  if (prop.select) return prop.select.name || "";
  if (prop.rich_text || prop.title) return readText(prop);
  return "";
}
function readStatus(prop) {
  if (!prop) return "";
  if (prop.status) return prop.status.name || "";
  if (prop.select) return prop.select.name || "";
  if (prop.multi_select) return prop.multi_select.map((x) => x.name).join(", ");
  if (prop.rich_text || prop.title) return readText(prop);
  return "";
}
// Source 열을 타입에 상관없이 읽기: URL 속성 / 텍스트에 붙여넣은 링크 / 링크가 걸린 텍스트 / 파일 모두 지원
function readUrl(prop) {
  if (!prop) return "";
  if (prop.url) return prop.url;                                  // URL 속성 타입
  const rt = prop.rich_text || prop.title;                       // 텍스트/제목 타입
  if (rt) {
    for (const t of rt) if (t.href) return t.href;               // 글자에 링크가 걸린 경우
    const txt = rt.map((t) => t.plain_text).join("").trim();     // 링크를 글자로 붙여넣은 경우
    if (txt) return /^https?:\/\//i.test(txt) ? txt : "https://" + txt.replace(/^\/+/, "");
  }
  if (prop.files && prop.files[0]) {                             // 파일&미디어 타입
    const f = prop.files[0];
    return (f.external && f.external.url) || (f.file && f.file.url) || "";
  }
  return "";
}
function meaningfulInsight(s) {
  const t = (s || "").trim().toLowerCase();
  return t.length > 0 && t !== "insight" && t !== "insights";
}

function headers(token, version) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": version,
    "Content-Type": "application/json",
  };
}

// 한 엔드포인트에서 모든 페이지(행)를 이어서 가져오기
async function queryAll(url, token, version) {
  let out = [];
  let cursor;
  do {
    const r = await fetch(url, {
      method: "POST",
      headers: headers(token, version),
      body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!r.ok) {
      const t = await r.text();
      const e = new Error(t);
      e.status = r.status;
      throw e;
    }
    const d = await r.json();
    out = out.concat(d.results || []);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return out;
}

// HTML 이스케이프 + 리치텍스트 -> 안전한 HTML
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function rtHtml(arr) {
  return (arr || []).map((t) => esc(t.plain_text)).join("");
}
// 한 블록의 자식들을 모두(페이지네이션 포함) 가져오기
async function fetchChildren(blockId, token) {
  let out = [], cursor;
  do {
    const url = `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : "");
    const r = await fetch(url, { headers: headers(token, "2022-06-28") });
    if (!r.ok) break;
    const d = await r.json();
    out = out.concat(d.results || []);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return out;
}
// 뉴스 페이지 본문(블록)을 인사이트 HTML로 조립 — 문단·소제목·목록·인용·표(table)까지 지원
async function readInsightBody(pageId, token) {
  try {
    const blocks = await fetchChildren(pageId, token);
    let html = "", listBuf = "", listTag = "";
    const flush = () => { if (listBuf) { html += `<${listTag}>${listBuf}</${listTag}>`; listBuf = ""; listTag = ""; } };
    for (const b of blocks) {
      const t = b.type, node = b[t] || {};
      if (t === "bulleted_list_item" || t === "numbered_list_item") {
        const tag = t === "bulleted_list_item" ? "ul" : "ol";
        if (listTag && listTag !== tag) flush();
        listTag = tag; listBuf += `<li>${rtHtml(node.rich_text)}</li>`;
        continue;
      }
      flush();
      if (t === "paragraph") { const x = rtHtml(node.rich_text); if (x.trim()) html += `<p>${x}</p>`; }
      else if (t.indexOf("heading") === 0) { const x = rtHtml(node.rich_text); if (x.trim()) html += `<h5 class="ih">${x}</h5>`; }
      else if (t === "quote") { const x = rtHtml(node.rich_text); if (x.trim()) html += `<blockquote>${x}</blockquote>`; }
      else if (t === "callout") { const x = rtHtml(node.rich_text); if (x.trim()) html += `<p>${x}</p>`; }
      else if (t === "to_do") { const x = rtHtml(node.rich_text); html += `<p>${node.checked ? "☑" : "☐"} ${x}</p>`; }
      else if (t === "code") { const x = rtHtml(node.rich_text); html += `<pre>${x}</pre>`; }
      else if (t === "divider") { html += "<hr>"; }
      else if (t === "table") {
        const rows = await fetchChildren(b.id, token);
        const hasHeader = node.has_column_header;
        let tb = "";
        rows.forEach((rw, ri) => {
          const cells = (rw.table_row && rw.table_row.cells) || [];
          const cellTag = hasHeader && ri === 0 ? "th" : "td";
          tb += "<tr>" + cells.map((c) => `<${cellTag}>${rtHtml(c)}</${cellTag}>`).join("") + "</tr>";
        });
        if (tb) html += `<div class="itbl-wrap"><table class="itbl">${tb}</table></div>`;
      }
      else { const x = rtHtml(node.rich_text); if (x.trim()) html += `<p>${x}</p>`; }
    }
    flush();
    return html;
  } catch (e) {
    return "";
  }
}

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;
  const debug = req.query && (req.query.debug || req.query.debug === "");

  if (!token || !dbId) {
    res.status(500).json({ error: "NOTION_TOKEN / NOTION_DB_ID 환경변수가 설정되지 않았습니다." });
    return;
  }

  const diag = {};
  let results = [];

  try {
    // 1) 새 구조: 데이터베이스에서 data source를 찾아 조회
    try {
      const dbRes = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
        headers: headers(token, "2025-09-03"),
      });
      if (dbRes.ok) {
        const db = await dbRes.json();
        const sources = db.data_sources || [];
        diag.data_sources = sources.length;
        for (const s of sources) {
          try {
            results = results.concat(
              await queryAll(`https://api.notion.com/v1/data_sources/${s.id}/query`, token, "2025-09-03")
            );
          } catch (e) {
            diag.ds_error = String(e.message || e).slice(0, 200);
          }
        }
      } else {
        diag.db_retrieve_status = dbRes.status;
      }
    } catch (e) {
      diag.retrieve_error = String(e.message || e).slice(0, 150);
    }

    // 2) 레거시 폴백: 위에서 아무것도 못 얻으면 예전 방식으로 조회
    if (results.length === 0) {
      try {
        results = await queryAll(`https://api.notion.com/v1/databases/${dbId}/query`, token, "2022-06-28");
        diag.legacy = true;
      } catch (e) {
        res.status(500).json({
          error: "노션 조회 실패 — 통합 연결(Connections), 토큰, DB ID를 확인하세요.",
          status: e.status || null,
          detail: String(e.message || e).slice(0, 400),
          diag,
        });
        return;
      }
    }

    // 3) 변환
    let posts = await Promise.all(
      results.map(async (page, i) => {
        const p = page.properties || {};
        const status = readStatus(getProp(p, "Status"));
        // 인사이트: Insight 속성에 글이 있으면 그 텍스트를 HTML 문단으로, 없으면 페이지 본문(표 포함)을 HTML로
        const insightProp = readText(getProp(p, "Insight"));
        let insight;
        if (meaningfulInsight(insightProp)) {
          insight = "<p>" + esc(insightProp).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
        } else {
          insight = await readInsightBody(page.id, token);
        }
        const dateProp = getProp(p, "Date of Issue");
        const sourceProp = getProp(p, "Source");
        const tagProp = getProp(p, "Tag");
        return {
          id: i + 1,
          status,
          title: readText(getProp(p, "Title")),
          author: readAuthor(getProp(p, "Author")),
          summary: readText(getProp(p, "Content Summary")),
          insight,
          source: readUrl(sourceProp),
          date: (dateProp && dateProp.date && dateProp.date.start) || "",
          tags: tagProp && tagProp.multi_select ? tagProp.multi_select.map((t) => t.name) : [],
        };
      })
    );

    // 진단 모드: 원본 개수/상태값 확인
    if (debug) {
      const first = results[0] && results[0].properties ? results[0].properties : null;
      res.status(200).json({
        raw_count: results.length,
        published_count: posts.filter((x) => x.title && PUBLISH_STATUS.includes(normStatus(x.status))).length,
        first_row: first
          ? {
              title: readText(getProp(first, "Title")),
              status: readStatus(getProp(first, "Status")),
              status_norm: normStatus(readStatus(getProp(first, "Status"))),
              status_raw: getProp(first, "Status"),
              property_names: Object.keys(first),
            }
          : null,
        diag,
      });
      return;
    }

    // 게시 필터 + 최신순
    posts = posts.filter((x) => x.title && PUBLISH_STATUS.includes(normStatus(x.status)));
    posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(posts);
  } catch (e) {
    res.status(500).json({ error: String(e), diag });
  }
}
