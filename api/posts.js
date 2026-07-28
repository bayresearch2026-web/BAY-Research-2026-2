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
// 주제 열은 이 이름들 중 먼저 발견되는 것을 씁니다 (대소문자 무시)
const TOPIC_NAMES = ["Topic", "Topics", "주제", "Category", "카테고리", "분류"];
function getTopicProp(props) {
  for (const n of TOPIC_NAMES) {
    const found = getProp(props, n);
    if (found) return [n, found];
  }
  return [null, null];
}
// 주제(Topic) 열 읽기 — 선택/다중선택/텍스트 중 무엇으로 만들어도 동작합니다
function readTopics(prop) {
  if (!prop) return [];
  if (prop.multi_select) return prop.multi_select.map((x) => x.name).filter(Boolean);
  if (prop.select) return prop.select.name ? [prop.select.name] : [];
  if (prop.status) return prop.status.name ? [prop.status.name] : [];
  const arr = prop.rich_text || prop.title;
  if (arr) {
    const txt = arr.map((t) => t.plain_text).join("").trim();
    return txt ? txt.split(/[,·/|]/).map((s) => s.trim()).filter(Boolean) : [];
  }
  return [];
}
// Editor's Picks 열 읽기 — 체크박스가 가장 정확하지만, 선택/텍스트로 만들어도 동작합니다
const PICK_NAMES = ["Pick", "Picks", "Editor's Pick", "Editors Pick", "에디터픽", "에디터 픽", "추천"];
const PICK_TRUE = ["true", "yes", "y", "o", "on", "1", "체크", "추천", "픽", "pick"];
function readPick(props) {
  for (const n of PICK_NAMES) {
    const prop = getProp(props, n);
    if (!prop) continue;
    if (typeof prop.checkbox === "boolean") return prop.checkbox;   // 체크박스 타입
    if (prop.select) return !!prop.select.name;                     // 값이 있으면 픽으로 간주
    if (prop.status) return !!prop.status.name;
    if (prop.multi_select) return prop.multi_select.length > 0;
    const txt = readText(prop).trim().toLowerCase();
    if (txt) return PICK_TRUE.includes(txt);
  }
  return false;
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
  return (arr || [])
    .map((t) => {
      let s = esc(t.plain_text);
      // 노션에서 준 글자 서식(굵게·기울임·코드·취소선·밑줄)을 그대로 살립니다
      const a = t.annotations || {};
      if (a.code) s = `<code>${s}</code>`;
      if (a.bold) s = `<strong>${s}</strong>`;
      if (a.italic) s = `<em>${s}</em>`;
      if (a.strikethrough) s = `<s>${s}</s>`;
      if (a.underline) s = `<u>${s}</u>`;
      if (t.href) return `<a href="${esc(t.href)}" target="_blank" rel="noopener">${s}</a>`;
      // 맨텍스트로 적힌 URL도 자동으로 링크 처리
      return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    })
    .join("");
}
// 토글·단(컬럼)·콜아웃처럼 "안에 또 내용이 들어가는" 블록들.
// 예전에는 맨 바깥 블록만 읽어서 토글 안에 넣은 이미지가 통째로 사라졌습니다.
const CONTAINER_TYPES = [
  "toggle", "column_list", "column", "callout", "quote", "synced_block",
  "bulleted_list_item", "numbered_list_item", "to_do", "template",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 한 번에 너무 많은 요청을 보내면 노션이 429(요청 과다)로 막아버려서
// 이미지가 "어떤 글은 되고 어떤 글은 안 되는" 현상이 생깁니다.
// 그래서 동시에 처리하는 개수를 제한합니다.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// 한 블록의 자식들을 모두(페이지네이션 포함) 가져오기 — 429는 잠깐 쉬었다 재시도
async function fetchChildren(blockId, token) {
  let out = [], cursor;
  do {
    const url = `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100` + (cursor ? `&start_cursor=${cursor}` : "");
    let r = await fetch(url, { headers: headers(token, "2022-06-28") });
    if (r.status === 429) {
      const wait = Math.min(1500, (Number(r.headers.get("retry-after")) || 1) * 1000);
      await sleep(wait);
      r = await fetch(url, { headers: headers(token, "2022-06-28") });
    }
    if (!r.ok) break;
    const d = await r.json();
    out = out.concat(d.results || []);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return out;
}
// 노션 이미지 블록에서 실제 주소 꺼내기 (외부 링크 / 노션 업로드 모두 지원)
// 주의: 노션 업로드 파일 주소는 약 1시간 후 만료됩니다. 이 함수는 요청할 때마다
//       노션에서 새로 받아오므로(캐시 60초) 평소 사용에는 문제가 없습니다.
function imageUrl(node) {
  if (!node) return "";
  return (
    (node.external && node.external.url) ||
    (node.file && node.file.url) ||
    (node.file_upload && node.file_upload.url) ||   // 새 업로드 방식
    node.url ||                                      // embed 블록
    ""
  );
}
// 이미지는 우리 서버(/api/img)를 거쳐 내보냅니다.
// 언론사 핫링크 차단·노션 주소 만료 때문에 브라우저에서 직접 부르면 안 뜨는 경우가 많습니다.
function proxied(u) {
  if (!u) return "";
  if (u.indexOf("/") === 0 || u.indexOf("data:") === 0) return u;   // 우리 파일은 그대로
  return "/api/img?u=" + encodeURIComponent(u);
}
// 파일/임베드 블록이 실제로 그림인지 확인 (확장자 또는 노션 파일 저장소 주소)
function looksLikeImageUrl(u) {
  const s = String(u || "").split("?")[0].toLowerCase();
  return /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/.test(s) ||
         s.indexOf("prod-files-secure") !== -1 ||
         s.indexOf("notion.so/image") !== -1 ||
         s.indexOf("notion-static.com") !== -1;
}
// 페이지 표지(cover) 이미지
function pageCoverUrl(page) {
  const c = page && page.cover;
  if (!c) return "";
  return (c.external && c.external.url) || (c.file && c.file.url) || "";
}
// 파일&미디어 타입 속성(Image/Thumbnail/Cover 등)에서 이미지 꺼내기
const IMAGE_PROP_NAMES = ["Image", "Thumbnail", "Cover", "이미지", "썸네일", "대표이미지"];
function readImageProp(props) {
  for (const n of IMAGE_PROP_NAMES) {
    const prop = getProp(props, n);
    if (prop && prop.files && prop.files[0]) {
      const f = prop.files[0];
      const u = (f.external && f.external.url) || (f.file && f.file.url) || "";
      if (u) return u;
    }
  }
  return "";
}

// 뉴스 페이지 본문(블록)을 인사이트 HTML로 조립 — 문단·소제목·목록·인용·표(table)·이미지 지원
// 반환: { html, images } — images[0]은 대표 이미지(썸네일/상단 배너)로 씁니다
// "출처: 블록미디어" 처럼 이미지 바로 아래에 적은 출처 줄을 알아봅니다.
// 노션 캡션으로 달아도 되고, 그냥 문단으로 적어도 출처로 인식합니다.
const SRC_WORD = "(?:이미지\\s*출처|사진\\s*출처|자료\\s*출처|출처|사진|자료|source|photo|credit|image)";
const SOURCE_RE = new RegExp("^\\s*" + SRC_WORD + "\\s*[:：\\-–·]\\s*\\S", "i");        // "출처: 블록미디어"
const SOURCE_LOOSE_RE = new RegExp("^\\s*" + SRC_WORD + "\\s+\\S", "i");                 // "출처 블록미디어"
function looksLikeSource(txt) {
  const t = (txt || "").trim();
  if (!t || t.length > 80) return false;
  if (SOURCE_RE.test(t)) return true;
  // 구분기호 없이 띄어쓰기만 있는 경우는 짧은 줄일 때만 출처로 봅니다
  // (그래야 "출처를 밝히지 않은 이번 보도는…" 같은 본문 문장이 잘못 걸리지 않습니다)
  return t.length <= 30 && SOURCE_LOOSE_RE.test(t);
}

// 토글·단(컬럼) 안에 들어 있는 블록까지 순서를 지키며 평평하게 펼칩니다.
async function flattenBlocks(blockId, token, depth) {
  const d = depth || 0;
  const out = [];
  if (d > 3) return out;                       // 너무 깊게 들어가지 않도록 안전장치
  const blocks = await fetchChildren(blockId, token);
  for (const b of blocks) {
    const t = b.type;
    // 단(컬럼)·동기화 블록은 그 자체로는 보여줄 내용이 없으므로 껍데기는 건너뜁니다
    if (t !== "column_list" && t !== "column" && t !== "synced_block") out.push(b);
    if (b.has_children && CONTAINER_TYPES.indexOf(t) !== -1) {
      const kids = await flattenBlocks(b.id, token, d + 1);
      for (const k of kids) out.push(k);
    }
  }
  return out;
}

async function readInsightBody(pageId, token) {
  const images = [];
  let imagesHtml = "";     // 본문에 보여줄 이미지들만 따로 모아둔 HTML
  try {
    const blocks = await flattenBlocks(pageId, token);
    // 글 맨 앞에 놓인 이미지는 "표지"로 보고 상단 배너로 올립니다(본문에서는 생략).
    // 글 중간에 넣은 이미지는 넣은 자리에 그대로 보여줍니다.
    const firstMeaningful = blocks.find((b) => {
      const t = b.type, n = b[t] || {};
      if (t === "image" || t === "table" || t === "divider") return true;
      return (n.rich_text || []).map((x) => x.plain_text).join("").trim().length > 0;
    });
    const leadIsTop = !!firstMeaningful && firstMeaningful.type === "image";
    let html = "", listBuf = "", listTag = "";
    let pendingImg = null;   // 다음 블록이 출처 줄인지 보려고 이미지를 잠깐 들고 있습니다
    // 번호 목록이 문단 때문에 끊겨도 1로 되돌아가지 않도록 번호를 이어서 셉니다
    let olNext = 1, olStart = 1;
    const flush = () => {
      if (!listBuf) return;
      html += listTag === "ol" ? `<ol start="${olStart}">${listBuf}</ol>` : `<ul>${listBuf}</ul>`;
      listBuf = ""; listTag = "";
    };
    // 들고 있던 이미지를 실제로 내보냅니다.
    // 글 맨 앞에 놓인 표지용 이미지 1장만 본문에서 빼고, 나머지는 전부 제자리에 표시합니다.
    const flushImage = () => {
      if (!pendingImg) return;
      const im = pendingImg;
      pendingImg = null;
      images.push(im);
      const isTopCover = images.length === 1 && leadIsTop;
      if (isTopCover) return;
      // 노션에 올린 이미지 주소는 시간이 지나면 만료됩니다. 그때 깨진 아이콘 대신 조용히 사라지게 합니다.
      const fig =
        `<figure class="ifig"><img src="${esc(proxied(im.url))}" data-raw="${esc(im.url)}"` +
        ` alt="${esc(im.capTxt)}" loading="lazy" referrerpolicy="no-referrer" onerror="imgFallback(this)">` +
        (im.capHtml ? `<figcaption>${im.capHtml}</figcaption>` : "") + `</figure>`;
      flush();
      html += fig;
      imagesHtml += fig;
    };
    for (const b of blocks) {
      const t = b.type, node = b[t] || {};
      // 이미지 바로 다음 문단이 "출처: ..." 형태면 본문에 넣지 않고 그 이미지의 출처로 씁니다
      if (pendingImg && (t === "paragraph" || t === "callout" || t === "quote")) {
        const txt = (node.rich_text || []).map((x) => x.plain_text).join("").trim();
        if (looksLikeSource(txt)) {
          pendingImg.capTxt = txt;
          pendingImg.capHtml = rtHtml(node.rich_text);
          continue;
        }
      }
      flushImage();
      if (t === "bulleted_list_item" || t === "numbered_list_item") {
        const tag = t === "bulleted_list_item" ? "ul" : "ol";
        if (listTag && listTag !== tag) flush();
        if (tag === "ol") { if (!listTag) olStart = olNext; olNext++; }
        listTag = tag; listBuf += `<li>${rtHtml(node.rich_text)}</li>`;
        continue;
      }
      flush();
      if (t === "paragraph") { const x = rtHtml(node.rich_text); if (x.trim()) html += `<p>${x}</p>`; }
      else if (t.indexOf("heading") === 0) {
        // 소제목이 나오면 번호 매기기를 새로 시작
        olNext = 1;
        const lv = t === "heading_1" ? 1 : t === "heading_2" ? 2 : 3;
        const x = rtHtml(node.rich_text);
        if (x.trim()) html += `<h${lv + 2} class="ih ih${lv}">${x}</h${lv + 2}>`;
      }
      else if (t === "quote") { const x = rtHtml(node.rich_text); if (x.trim()) html += `<blockquote>${x}</blockquote>`; }
      else if (t === "callout") { const x = rtHtml(node.rich_text); if (x.trim()) html += `<p>${x}</p>`; }
      else if (t === "to_do") { const x = rtHtml(node.rich_text); html += `<p>${node.checked ? "☑" : "☐"} ${x}</p>`; }
      else if (t === "code") { const x = rtHtml(node.rich_text); html += `<pre>${x}</pre>`; }
      else if (t === "divider") { olNext = 1; html += "<hr>"; }
      // image 블록뿐 아니라, 이미지를 파일로 첨부(file)하거나 링크로 삽입(embed)한 경우도 받아줍니다
      else if (t === "image" || t === "file" || t === "embed") {
        const u = imageUrl(node);
        if (u && (t === "image" || looksLikeImageUrl(u))) {
          // 노션 캡션이 있으면 그대로 출처로 쓰고, 없으면 다음 문단이 출처인지 살펴봅니다
          const capTxt = (node.caption || []).map((c) => c.plain_text).join("").trim();
          pendingImg = { url: u, capTxt, capHtml: capTxt ? rtHtml(node.caption) : "" };
        }
      }
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
    flushImage();
    flush();
    return { html, images, imagesHtml, leadIsTop };
  } catch (e) {
    return { html: "", images, imagesHtml: "", leadIsTop: false };
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
    // 동시에 6개씩만 처리 — 노션 요청 제한(429)에 걸려 이미지가 누락되는 것을 막습니다
    let posts = await mapLimit(results, 6,
      (async (page, i) => {
        const p = page.properties || {};
        const status = readStatus(getProp(p, "Status"));
        // 인사이트: Insight 속성에 글이 있으면 그 텍스트를 HTML 문단으로, 없으면 페이지 본문(표 포함)을 HTML로
        const insightProp = readText(getProp(p, "Insight"));
        // 본문(블록)은 "항상" 읽습니다.
        // 예전에는 Insight 속성에 글자가 있으면 본문을 통째로 건너뛰어서,
        // 본문에 넣은 이미지가 전부 사라졌습니다. (이미지가 안 뜨던 가장 큰 원인)
        const body = await readInsightBody(page.id, token);
        const bodyImages = body.images;
        let insight = "", insightMd = "", extraImagesHtml = "";
        if (meaningfulInsight(insightProp)) {
          // 속성에 적힌 글은 마크다운 원문 그대로 넘기고, 화면에서 marked.js가 해석합니다.
          // 본문에 넣어둔 이미지는 그 아래에 이어 붙여 함께 보여줍니다.
          insightMd = insightProp;
          extraImagesHtml = body.imagesHtml;
        } else {
          insight = body.html;
        }
        // 대표 이미지: 본문 첫 이미지 → 페이지 표지 → Image/썸네일 속성 순
        const first = bodyImages[0] || null;
        const coverRaw = (first && first.url) || pageCoverUrl(page) || readImageProp(p) || "";
        const cover = proxied(coverRaw);
        // 이 대표 이미지가 본문 안에도 그대로 나오는지 여부.
        // 나온다면 기사 상단 배너는 생략해 같은 사진이 두 번 뜨지 않게 합니다.
        const coverInBody = !!first && !body.leadIsTop;
        // 이미지 출처 = 노션에서 그 이미지 밑에 적은 캡션
        const coverCaption = (first && first.capHtml) || "";
        const dateProp = getProp(p, "Date of Issue");
        const sourceProp = getProp(p, "Source");
        const tagProp = getProp(p, "Tag");
        const likeProp = getProp(p, "Likes");
        const viewProp = getProp(p, "Views");
        return {
          pick: readPick(p),                                 // Editor's Picks 노출 여부
          id: i + 1,
          pageId: page.id,                                   // 좋아요 저장에 쓰는 고유 주소
          likes: (likeProp && Number(likeProp.number)) || 0,
          views: (viewProp && Number(viewProp.number)) || 0,
          status,
          title: readText(getProp(p, "Title")),
          author: readAuthor(getProp(p, "Author")),
          summary: readText(getProp(p, "Content Summary")),
          insight,
          insightMd,
          extraImagesHtml,                                   // Insight 속성을 쓸 때 본문에 있던 이미지들
          cover,                                             // 상단 배너 / 카드 썸네일용 대표 이미지
          coverRaw,                                          // 프록시가 실패했을 때 쓸 원본 주소
          coverInBody,                                       // 대표 이미지가 본문에도 나오는지
          coverCaption,                                      // 이미지 출처 (노션 캡션)
          source: readUrl(sourceProp),
          date: (dateProp && dateProp.date && dateProp.date.start) || "",
          tags: tagProp && tagProp.multi_select ? tagProp.multi_select.map((t) => t.name) : [],
          topics: readTopics(getTopicProp(p)[1]),
        };
      }));

    // 진단 모드 ②: 특정 글 하나만 자세히 —  /api/posts?debug=1&q=칼시
    // 그 글의 노션 블록을 순서대로 늘어놓고, 이미지가 어떤 형태로 들어있는지 보여줍니다.
    const q = (req.query && (req.query.q || req.query.title)) || "";
    if (debug && q) {
      const hit = results.find((r) =>
        readText(getProp(r.properties || {}, "Title")).indexOf(String(q)) !== -1);
      if (!hit) {
        res.status(200).json({ 찾음: false, 검색어: q });
        return;
      }
      const blocks = await flattenBlocks(hit.id, token);
      const body = await readInsightBody(hit.id, token);
      const post = posts.find((x) => x.pageId === hit.id) || {};
      res.status(200).json({
        찾음: true,
        제목: readText(getProp(hit.properties, "Title")),
        블록수: blocks.length,
        블록목록: blocks.slice(0, 40).map((b) => {
          const t = b.type, n = b[t] || {};
          const o = { 타입: t, 자식있음: !!b.has_children };
          if (t === "image" || t === "file" || t === "embed") {
            o.이미지형태 = n.type || (n.external ? "external" : n.file ? "file" : "?");
            o.주소 = String(imageUrl(n)).slice(0, 120) || "(주소 없음)";
            o.그림으로_인정 = t === "image" || looksLikeImageUrl(imageUrl(n));
          } else {
            o.글 = (n.rich_text || []).map((x) => x.plain_text).join("").slice(0, 40);
          }
          return o;
        }),
        찾은_이미지수: body.images.length,
        맨앞이_이미지: body.leadIsTop,
        대표이미지: post.cover || "(없음)",
        대표이미지가_본문에도_나옴: !!post.coverInBody,
        Insight속성_사용: !!post.insightMd,
      });
      return;
    }

    // 진단 모드: 원본 개수/상태값 확인
    if (debug) {
      const first = results[0] && results[0].properties ? results[0].properties : null;
      const [topicName, topicProp] = first ? getTopicProp(first) : [null, null];
      res.status(200).json({
        raw_count: results.length,
        published_count: posts.filter((x) => x.title && PUBLISH_STATUS.includes(normStatus(x.status))).length,
        주제열_찾음: !!topicName,
        주제열_이름: topicName,
        주제열_타입: topicProp ? topicProp.type : null,
        주제열에서_읽은값: readTopics(topicProp),
        주제_있는_글수: posts.filter((x) => (x.topics || []).length).length,
        대표이미지_있는_글수: posts.filter((x) => x.cover).length,
        대표이미지_예시: (posts.find((x) => x.cover) || {}).cover || null,
        본문에_이미지가_보이는_글수: posts.filter((x) => (x.insight || "").indexOf("ifig") !== -1 || x.extraImagesHtml).length,
        Insight속성을_쓴_글수: posts.filter((x) => x.insightMd).length,
        Insight속성_쓰면서_본문이미지도_있는_글수: posts.filter((x) => x.insightMd && x.extraImagesHtml).length,
        찾아본_이름들: TOPIC_NAMES,
        first_row: first
          ? {
              title: readText(getProp(first, "Title")),
              status: readStatus(getProp(first, "Status")),
              status_norm: normStatus(readStatus(getProp(first, "Status"))),
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

    // 본문까지 모두 읽으므로 조금 더 오래 캐시합니다.
    // (노션 업로드 이미지 주소는 약 1시간 뒤 만료되므로 그보다 훨씬 짧게 잡습니다)
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(posts);
  } catch (e) {
    res.status(500).json({ error: String(e), diag });
  }
}
