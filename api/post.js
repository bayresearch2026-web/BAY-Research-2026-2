// =====================================================================
// /api/post?pageId=...  —  기사 하나의 "본문(인사이트)"만 읽어오는 함수
//
// 목록 화면(/api/posts)은 이제 본문을 읽지 않습니다.
// 독자가 기사를 눌렀을 때 그 글 하나만 여기서 읽어옵니다. (보통 0.5~1초)
// 덕분에 첫 화면이 20~30초 → 1~2초로 줄었습니다.
//
// 진단: /api/post?pageId=...&debug=1 → 그 글의 블록 구조를 보여줍니다.
// =====================================================================

import {
  proxied, imageUrl, looksLikeImageUrl, flattenBlocks, readInsightBody,
} from "./_notion.js";

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const pageId = req.query && (req.query.pageId || req.query.id);
  const debug = req.query && (req.query.debug || req.query.debug === "");

  if (!token) {
    res.status(500).json({ error: "NOTION_TOKEN 환경변수가 설정되지 않았습니다." });
    return;
  }
  if (!pageId) {
    res.status(400).json({ error: "pageId 가 필요합니다. 예: /api/post?pageId=..." });
    return;
  }

  try {
    const body = await readInsightBody(String(pageId), token);
    const first = body.images[0] || null;

    if (debug) {
      const blocks = await flattenBlocks(String(pageId), token);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
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
      });
      return;
    }

    // 캐시: 본문은 자주 바뀌지 않으므로 목록보다 조금 더 오래 담아둡니다.
    // (노션 이미지 주소가 1시간 뒤 만료되므로 그보다 넉넉히 짧게 잡았습니다)
    if (req.query && req.query.fresh) res.setHeader("Cache-Control", "no-store");
    else res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=1200");

    res.status(200).json({
      pageId: String(pageId),
      insight: body.html,                                   // 노션 본문 → HTML
      imagesHtml: body.imagesHtml,                          // Insight 속성을 쓴 글에 이어 붙일 이미지들
      coverRaw: (first && first.url) || "",                 // 본문 첫 이미지(대표)
      cover: proxied((first && first.url) || ""),
      coverCaption: (first && first.capHtml) || "",         // 이미지 출처(노션 캡션)
      coverInBody: !!first && !body.leadIsTop,              // 대표 이미지가 본문에도 나오는지
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
  }
}
