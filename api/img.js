// =====================================================================
// /api/img?u=<이미지주소>  —  이미지 중계(프록시)
//
// 왜 필요한가:
//  1) 매일경제(mk.co.kr)처럼 상당수 언론사는 "핫링크 차단"을 겁니다.
//     다른 사이트에서 이미지 주소를 직접 부르면 어디서 왔는지(Referer)를 보고
//     차단해버려서, 노션에서는 잘 보이던 사진이 우리 홈페이지에서는 안 뜹니다.
//  2) 노션에 직접 올린 사진의 주소는 약 1시간 뒤 만료됩니다.
//
//  이 함수가 서버에서 대신 받아와 우리 도메인으로 다시 내보내므로
//  브라우저 입장에서는 그냥 우리 사이트 이미지가 되어 위 문제가 모두 사라집니다.
//  받아온 이미지는 CDN에 하루 동안 저장해 두므로 느려지지 않습니다.
// =====================================================================

const MAX_BYTES = 8 * 1024 * 1024; // 8MB 넘는 이미지는 그냥 포기

// 사내망·로컬 주소로 요청이 새어나가지 않도록 최소한의 안전장치
function isSafeUrl(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "[::1]") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}

export default async function handler(req, res) {
  const u = (req.query && req.query.u) || "";
  if (!u || !isSafeUrl(u)) {
    res.status(400).json({ error: "이미지 주소(u)가 없거나 올바르지 않습니다." });
    return;
  }

  const origin = new URL(u).origin;
  // 원래 사이트에서 보는 것처럼 요청해야 핫링크 차단을 통과합니다
  const tries = [
    { Referer: origin + "/", Origin: origin },
    {},                       // 그래도 막히면 Referer 없이 한 번 더
  ];

  for (const extra of tries) {
    try {
      const r = await fetch(u, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
          ...extra,
        },
        redirect: "follow",
      });
      if (!r.ok) continue;

      const ct = r.headers.get("content-type") || "";
      if (!/^image\//i.test(ct)) continue;

      const len = Number(r.headers.get("content-length") || 0);
      if (len && len > MAX_BYTES) continue;

      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) continue;

      res.setHeader("Content-Type", ct);
      // CDN에 하루 보관 — 원본 사이트를 반복해서 두드리지 않습니다
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
      res.status(200).send(buf);
      return;
    } catch (e) {
      // 다음 방법으로 재시도
    }
  }

  // 다 실패하면 원본 주소로 넘겨줍니다 (브라우저가 직접 시도해 볼 기회)
  res.setHeader("Cache-Control", "public, max-age=60");
  res.redirect(302, u);
}
