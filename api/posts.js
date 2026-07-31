// =====================================================================
// /api/posts  —  목록 화면에 필요한 정보만 돌려주는 가벼운 함수
//
// [속도 개선 요약]
// 예전에는 목록 한 줄을 그리려고 글 72개의 노션 "본문"을 전부 읽었습니다.
// 그래서 첫 화면이 뜨는 데 20~30초가 걸렸습니다.
// 이제는 목록에 실제로 필요한 것(제목·작성자·날짜·요약·주제·썸네일)만 읽고,
// 기사 본문은 그 글을 눌렀을 때 /api/post 가 하나만 읽어옵니다.
//
// 필요한 환경변수(Vercel): NOTION_TOKEN, NOTION_DB_ID
// 진단: 주소 뒤에 ?debug=1 을 붙이면 원본 개수/상태값을 확인할 수 있습니다.
// =====================================================================

import {
  PUBLISH_STATUS, normStatus, readText, getProp, readAuthor, readStatus, readUrl,
  TOPIC_NAMES, getTopicProp, readTopics, readPick, meaningfulInsight,
  mapLimit, proxied, pageCoverUrl, readImageProp, findFirstImage, fetchRows,
} from "./_notion.js";

// 썸네일을 찾으려고 노션을 동시에 몇 개까지 두드릴지.
// 본문을 통째로 읽지 않으므로 예전(6)보다 크게 올려도 안전합니다.
const IMG_CONCURRENCY = 16;

export default async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;
  const debug = req.query && (req.query.debug || req.query.debug === "");

  if (!token || !dbId) {
    res.status(500).json({ error: "NOTION_TOKEN / NOTION_DB_ID 환경변수가 설정되지 않았습니다." });
    return;
  }

  const diag = {};

  try {
    // 1) 노션에서 모든 행 읽기
    let results;
    try {
      results = await fetchRows(token, dbId, diag);
    } catch (e) {
      res.status(500).json({
        error: "노션 조회 실패 — 통합 연결(Connections), 토큰, DB ID를 확인하세요.",
        status: e.status || null,
        detail: String(e.message || e).slice(0, 400),
        diag,
      });
      return;
    }

    // 2) 게시글만 먼저 걸러냅니다
    //    (예전에는 숨긴 글·미완 글까지 본문을 전부 읽어 시간을 버렸습니다)
    const rows = results.filter((page) => {
      const p = page.properties || {};
      if (!readText(getProp(p, "Title"))) return false;
      return PUBLISH_STATUS.includes(normStatus(readStatus(getProp(p, "Status"))));
    });

    // 3) 목록용 정보로 변환 — 본문(블록)은 읽지 않습니다
    let posts = await mapLimit(rows, IMG_CONCURRENCY, async (page) => {
      const p = page.properties || {};
      const dateProp = getProp(p, "Date of Issue");
      const tagProp = getProp(p, "Tag");
      const likeProp = getProp(p, "Likes");
      const viewProp = getProp(p, "Views");
      const insightProp = readText(getProp(p, "Insight"));

      // 썸네일: 본문 첫 이미지 → 페이지 표지 → Image/썸네일 속성 순 (기존과 같은 우선순위)
      // 단, 본문을 전부 읽지 않고 맨 바깥 블록만 한 번 훑어봅니다.
      const shot = await findFirstImage(page.id, token);
      const coverRaw = shot.url || pageCoverUrl(page) || readImageProp(p) || "";

      return {
        pick: readPick(p),                                 // Editor's Picks 노출 여부
        pageId: page.id,                                   // 좋아요·본문 불러오기에 쓰는 고유 주소
        likes: (likeProp && Number(likeProp.number)) || 0,
        views: (viewProp && Number(viewProp.number)) || 0,
        status: readStatus(getProp(p, "Status")),
        title: readText(getProp(p, "Title")),
        author: readAuthor(getProp(p, "Author")),
        summary: readText(getProp(p, "Content Summary")),
        // Insight 속성에 직접 쓴 글은 짧은 텍스트라 목록에 같이 실어 보냅니다
        insightMd: meaningfulInsight(insightProp) ? insightProp : "",
        cover: proxied(coverRaw),                          // 카드 썸네일 / 기사 상단 배너
        coverRaw,                                          // 프록시가 실패했을 때 쓸 원본 주소
        coverInBody: !!shot.url && !shot.leadIsTop,        // 대표 이미지가 본문에도 나오는지
        source: readUrl(getProp(p, "Source")),
        date: (dateProp && dateProp.date && dateProp.date.start) || "",
        tags: tagProp && tagProp.multi_select ? tagProp.multi_select.map((t) => t.name) : [],
        topics: readTopics(getTopicProp(p)[1]),
      };
    });

    // 최신순으로 정렬한 뒤 번호를 매깁니다 (주소 #/post/3 의 그 번호)
    posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    posts.forEach((p, i) => { p.id = i + 1; });

    // 진단 모드: 원본 개수/상태값 확인
    if (debug) {
      const first = results[0] && results[0].properties ? results[0].properties : null;
      const [topicName, topicProp] = first ? getTopicProp(first) : [null, null];
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        raw_count: results.length,
        published_count: posts.length,
        주제열_찾음: !!topicName,
        주제열_이름: topicName,
        주제열_타입: topicProp ? topicProp.type : null,
        주제열에서_읽은값: readTopics(topicProp),
        주제_있는_글수: posts.filter((x) => (x.topics || []).length).length,
        대표이미지_있는_글수: posts.filter((x) => x.cover).length,
        대표이미지_예시: (posts.find((x) => x.cover) || {}).cover || null,
        Insight속성을_쓴_글수: posts.filter((x) => x.insightMd).length,
        찾아본_이름들: TOPIC_NAMES,
        안내: "본문(인사이트)은 /api/post?pageId=... 에서 따로 읽습니다.",
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

    // 캐시 정책 (속도 개선의 또 다른 축)
    //  - s-maxage=300                : CDN이 5분간 그대로 내보냅니다 (노션을 자주 두드리지 않음)
    //  - stale-while-revalidate=1200 : 5분이 지나도 일단 예전 것을 "즉시" 보여주고,
    //                                  뒤에서 조용히 새로 받아옵니다 → 기다리는 사람이 없습니다
    // 노션 이미지 주소는 1시간 뒤 만료되므로, 최대 25분(5+20)만 묵히도록 잡았습니다.
    // 주소 뒤에 ?fresh=1 을 붙이면 캐시를 무시하고 지금 바로 다시 읽습니다.
    if (req.query && req.query.fresh) res.setHeader("Cache-Control", "no-store");
    else res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=1200");
    res.status(200).json(posts);
  } catch (e) {
    res.status(500).json({ error: String(e), diag });
  }
}
