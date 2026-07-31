// =====================================================================
// /api/_notion.js — 노션에서 데이터를 읽는 공용 도구 모음
//
// 밑줄(_)로 시작하는 파일은 Vercel이 "주소"로 만들지 않고, 다른 함수가
// 가져다 쓰는 부품으로만 취급합니다. (직접 열리는 주소가 아닙니다)
//
//  - /api/posts  : 목록 화면용 (제목·작성자·날짜·주제·썸네일) — 본문은 읽지 않음
//  - /api/post   : 기사 하나를 열었을 때 그 글의 본문만 읽음
// 이렇게 나눈 덕분에 첫 화면이 20~30초 → 1~2초로 줄었습니다.
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

// ---------------------------------------------------------------------
// 대표이미지(썸네일)만 빠르게 찾기 — 목록 화면용
// 본문 전체를 읽지 않고, 맨 바깥 블록 한 번만 훑어봅니다.
// 토글·단(컬럼) 안에 이미지를 넣은 경우를 위해 딱 한 겹만 더 들어갑니다(최대 2번).
// ---------------------------------------------------------------------
async function findFirstImage(pageId, token) {
  try {
    const blocks = await fetchChildren(pageId, token);
    let seenText = false, budget = 2;
    for (const b of blocks) {
      const t = b.type, node = b[t] || {};
      if (t === "image" || t === "file" || t === "embed") {
        const u = imageUrl(node);
        if (u && (t === "image" || looksLikeImageUrl(u))) return { url: u, leadIsTop: !seenText };
      }
      if ((node.rich_text || []).map((x) => x.plain_text).join("").trim()) seenText = true;
      if (t === "table" || t === "divider") seenText = true;
    }
    // 맨 바깥에 그림이 없으면, 토글·단(컬럼) 안을 딱 한 겹만 더 봅니다
    for (const b of blocks) {
      if (budget <= 0) break;
      if (!b.has_children || CONTAINER_TYPES.indexOf(b.type) === -1) continue;
      budget--;
      const kids = await fetchChildren(b.id, token);
      for (const k of kids) {
        const t = k.type, node = k[t] || {};
        if (t === "image" || t === "file" || t === "embed") {
          const u = imageUrl(node);
          if (u && (t === "image" || looksLikeImageUrl(u))) return { url: u, leadIsTop: false };
        }
      }
    }
    return { url: "", leadIsTop: false };
  } catch (e) {
    return { url: "", leadIsTop: false };
  }
}

// ---------------------------------------------------------------------
// 노션 DB에서 모든 행 가져오기 (신 구조 → 실패하면 구 구조)
// ---------------------------------------------------------------------
async function fetchRows(token, dbId, diag) {
  const d = diag || {};
  let results = [];
  try {
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
      headers: headers(token, "2025-09-03"),
    });
    if (dbRes.ok) {
      const db = await dbRes.json();
      const sources = db.data_sources || [];
      d.data_sources = sources.length;
      for (const s of sources) {
        try {
          results = results.concat(
            await queryAll(`https://api.notion.com/v1/data_sources/${s.id}/query`, token, "2025-09-03")
          );
        } catch (e) {
          d.ds_error = String(e.message || e).slice(0, 200);
        }
      }
    } else {
      d.db_retrieve_status = dbRes.status;
    }
  } catch (e) {
    d.retrieve_error = String(e.message || e).slice(0, 150);
  }
  if (results.length === 0) {
    results = await queryAll(`https://api.notion.com/v1/databases/${dbId}/query`, token, "2022-06-28");
    d.legacy = true;
  }
  return results;
}

export {
  PUBLISH_STATUS, normStatus, readText, getProp, readAuthor, readStatus, readUrl,
  TOPIC_NAMES, getTopicProp, readTopics, readPick, meaningfulInsight,
  headers, queryAll, esc, rtHtml, CONTAINER_TYPES, sleep, mapLimit, fetchChildren,
  imageUrl, proxied, looksLikeImageUrl, pageCoverUrl, readImageProp,
  looksLikeSource, flattenBlocks, readInsightBody, findFirstImage, fetchRows,
};
