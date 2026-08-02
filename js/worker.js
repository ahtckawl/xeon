import { Chess } from "chess.js";

/* =========================================================
   공통 유틸
========================================================= */
// 실제 도메인: https://체스.홈페이지.한국
// 브라우저는 Origin 헤더를 한글이 아니라 퓨니코드(ASCII)로 보내기 때문에 이 값이 맞습니다.
const ALLOWED_ORIGIN = "https://xn--9t4b17p.xn--hu5b25b77nvwc.xn--3e0b707e";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function b64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/* =========================================================
   Firebase ID 토큰(클라이언트가 로그인 후 받는 JWT) 검증
========================================================= */
let jwkCache = { keys: null, fetchedAt: 0 };
const JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

async function getGoogleJwks() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (jwkCache.keys && Date.now() - jwkCache.fetchedAt < ONE_HOUR) {
    return jwkCache.keys;
  }
  const res = await fetch(JWK_URL);
  if (!res.ok) throw new Error("JWK fetch failed");
  const data = await res.json();
  jwkCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("잘못된 토큰 형식");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("aud 불일치");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("iss 불일치");
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("토큰 만료");
  if (typeof payload.iat !== "number" || payload.iat > now + 60) throw new Error("iat 이상");
  if (!payload.sub) throw new Error("sub(uid) 없음");

  const jwks = await getGoogleJwks();
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("일치하는 공개키 없음(kid)");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = b64urlToBytes(sigB64);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    signingInput
  );
  if (!valid) throw new Error("서명 검증 실패");

  return { uid: payload.sub };
}

/* =========================================================
   Google 서비스 계정으로 Firestore용 access token 발급
========================================================= */
let accessTokenCache = { token: null, expiresAt: 0 };
const TOKEN_CACHE_KEY = new Request("https://internal-cache.xeon/firestore-access-token");

function pemToArrayBuffer(pem) {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function getFirestoreAccessToken(env) {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt - 60000) {
    return accessTokenCache.token;
  }

  // 이 워커 인스턴스의 메모리 캐시가 비어있어도(재활용된 직후 등), 같은 데이터센터의
  // 다른 인스턴스가 저장해둔 토큰이 Cache API에 남아있으면 그걸 재사용 — OAuth 왕복 생략
  const edgeCache = caches.default;
  const cached = await edgeCache.match(TOKEN_CACHE_KEY);
  if (cached) {
    const saved = await cached.json();
    if (Date.now() < saved.expiresAt - 60000) {
      accessTokenCache = saved;
      return saved.token;
    }
  }

  const privateKeyPem = env.FIREBASE_PRIVATE_KEY.includes("\\n")
    ? env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : env.FIREBASE_PRIVATE_KEY;

  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = bytesToB64url(new TextEncoder().encode(JSON.stringify(header)));
  const claimsB64 = bytesToB64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${claimsB64}`;

  const keyData = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error("Google OAuth2 토큰 발급 실패: " + (await tokenRes.text()));
  }
  const tokenData = await tokenRes.json();
  accessTokenCache = {
    token: tokenData.access_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
  };

  // 다음 요청이 다른(또는 재활용된) 인스턴스에서 처리되더라도 재사용할 수 있도록 저장
  await edgeCache.put(
    TOKEN_CACHE_KEY,
    new Response(JSON.stringify(accessTokenCache), {
      headers: { "Cache-Control": `max-age=${Math.max(60, tokenData.expires_in - 120)}` },
    })
  );

  return accessTokenCache.token;
}

/* =========================================================
   Firestore REST 값 <-> JS 값 변환
========================================================= */
function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestoreValue) } };
  }
  if (typeof v === "object") {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = toFirestoreValue(v[k]);
    return { mapValue: { fields } };
  }
  throw new Error("지원하지 않는 값 타입: " + typeof v);
}

function fromFirestoreValue(v) {
  if (!v) return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in v) {
    const out = {};
    const fields = v.mapValue.fields || {};
    for (const k of Object.keys(fields)) out[k] = fromFirestoreValue(fields[k]);
    return out;
  }
  return null;
}

function docToJs(doc) {
  const out = {};
  const fields = doc.fields || {};
  for (const k of Object.keys(fields)) out[k] = fromFirestoreValue(fields[k]);
  return out;
}

/* =========================================================
   Firestore 문서 읽기 / 조건부 쓰기 / 조건부 삭제
   (updateTime 기반 낙관적 잠금)
========================================================= */
function roomUrl(env, roomId) {
  return `https://firestore.googleapis.com/v1/projects/${(env.FIREBASE_PROJECT_ID || "").trim()}/databases/(default)/documents/rooms/${roomId}`;
}

async function firestoreGet(env, roomId, accessToken) {
  const res = await fetch(roomUrl(env, roomId), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Firestore 읽기 실패: " + (await res.text()));
  const doc = await res.json();
  return { data: docToJs(doc), updateTime: doc.updateTime, name: doc.name };
}

async function firestoreConditionalUpdate(env, accessToken, docName, updateTime, updateFields) {
  const fields = {};
  for (const k of Object.keys(updateFields)) fields[k] = toFirestoreValue(updateFields[k]);

  const body = {
    writes: [
      {
        update: { name: docName, fields },
        updateMask: { fieldPaths: Object.keys(updateFields) },
        currentDocument: { updateTime },
      },
    ],
  };

  const url = `https://firestore.googleapis.com/v1/projects/${(env.FIREBASE_PROJECT_ID || "").trim()}/databases/(default)/documents:commit`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 409 || res.status === 400) {
    return { conflict: true, detail: await res.text() };
  }
  if (!res.ok) throw new Error("Firestore 쓰기 실패: " + (await res.text()));
  return { conflict: false };
}

async function firestoreConditionalDelete(env, accessToken, docName, updateTime) {
  const body = {
    writes: [
      {
        delete: docName,
        currentDocument: { updateTime },
      },
    ],
  };
  const url = `https://firestore.googleapis.com/v1/projects/${(env.FIREBASE_PROJECT_ID || "").trim()}/databases/(default)/documents:commit`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 409 || res.status === 400) {
    return { conflict: true, detail: await res.text() };
  }
  if (!res.ok) throw new Error("Firestore 삭제 실패: " + (await res.text()));
  return { conflict: false };
}

/* =========================================================
   낙관적 잠금 재시도 래퍼
   handler(data) -> { error, status } | { delete:true } | { update: {...} } | { noop:true }
========================================================= */
async function withRoomTransaction(env, roomId, handler) {
  const accessToken = await getFirestoreAccessToken(env);
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await firestoreGet(env, roomId, accessToken);
    if (!doc) return { error: "존재하지 않는 방", status: 404 };

    const result = await handler(doc.data);
    if (result.error) return result;
    if (result.noop) return { ok: true, data: doc.data };

    if (result.delete) {
      const del = await firestoreConditionalDelete(env, accessToken, doc.name, doc.updateTime);
      if (del.conflict) continue;
      return { ok: true, deleted: true };
    }

    const upd = await firestoreConditionalUpdate(env, accessToken, doc.name, doc.updateTime, result.update);
    if (upd.conflict) continue;
    return { ok: true, data: { ...doc.data, ...result.update } };
  }
  return { error: "동시 요청 충돌, 다시 시도해주세요", status: 409 };
}

function roleOf(data, uid) {
  if (data.hostId === uid) return "host";
  if (data.challengerId === uid) return "challenger";
  return null;
}
function colorOf(data, role) {
  if (role === "host") return data.hostColor;
  if (role === "challenger") return data.challengerColor;
  return null;
}

// moves(lan 배열)를 처음부터 재생해서 최종 fen/turn/lastMove를 계산
// (무르기로 마지막 수를 잘라낸 뒤 새 상태를 만들 때 사용)
function replayMoves(movesArr) {
  const game = new Chess();
  let last = null;
  for (const lan of movesArr || []) {
    const from = lan.slice(0, 2);
    const to = lan.slice(2, 4);
    const promotion = lan.slice(4) || undefined;
    last = game.move({ from, to, promotion });
  }
  return {
    fen: game.fen(),
    turn: game.turn() === "w" ? "white" : "black",
    lastMove: last
      ? { from: last.from, to: last.to, promotion: last.promotion || null, san: last.san }
      : null,
  };
}

async function requireAuth(request, env) {
  const body = await request.json();
  const { idToken } = body || {};
  if (!idToken) throw { status: 400, message: "idToken 누락" };
  try {
    const verified = await verifyFirebaseIdToken(idToken, (env.FIREBASE_PROJECT_ID || "").trim());
    return { uid: verified.uid, body };
  } catch (e) {
    throw { status: 401, message: "인증 실패: " + e.message };
  }
}

/* =========================================================
   /api/verify-admin
========================================================= */
async function handleVerifyAdmin(request, env) {
  const { password } = await request.json();
  if (typeof password !== "string" || !password) {
    return json({ ok: false, error: "비밀번호가 없어요" }, 400);
  }
  const hash = await sha256Hex(password);
  const ok = hash === env.ADMIN_PASSWORD_HASH;
  return json({ ok });
}

async function checkAdminPassword(env, password) {
  if (typeof password !== "string" || !password) return false;
  const hash = await sha256Hex(password);
  return hash === env.ADMIN_PASSWORD_HASH;
}

/* =========================================================
   /api/join  - 도전자 슬롯 선점
========================================================= */
async function handleJoin(request, env) {
  let uid, roomId;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);

  const result = await withRoomTransaction(env, roomId, (data) => {
    if (data.hostId === uid) return { noop: true };
    if (data.challengerId === uid) return { noop: true };
    if (data.challengerId) return { noop: true }; // 이미 다른 사람이 선점 -> 관전자로 처리는 클라이언트에서 판단
    return { update: { challengerId: uid, challengerReady: false } };
  });
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);

  const role = roleOf(result.data, uid) || "spectator";
  return json({ ok: true, role });
}

/* =========================================================
   /api/heartbeat  - 접속 생존 신호 (5초 간격 권장)
========================================================= */
async function handleHeartbeat(request, env) {
  let uid, roomId, active;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
    active = !!body.active; // 이번 하트비트 주기 사이에 실제 클릭(기물 클릭 포함)이 있었는지
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);

  const result = await withRoomTransaction(env, roomId, (data) => {
    const role = roleOf(data, uid);
    if (!role) return { error: "이 방의 플레이어가 아니에요", status: 403 };
    const seenField = role === "host" ? "hostLastSeenAt" : "challengerLastSeenAt";
    const actionField = role === "host" ? "hostLastActionAt" : "challengerLastActionAt";
    const now = new Date().toISOString();
    const update = { [seenField]: now };
    // 최초 하트비트(입장 직후)이거나 실제 활동이 있었을 때만 활동 시각 갱신
    if (!data[actionField] || active) update[actionField] = now;
    return { update };
  });
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true });
}

/* =========================================================
   /api/ready  - 준비 토글, 둘 다 준비되면 게임 시작
========================================================= */
async function handleReady(request, env) {
  let uid, roomId, ready;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
    ready = !!body.ready;
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);

  const result = await withRoomTransaction(env, roomId, (data) => {
    if (data.status !== "waiting") return { error: "대기중인 방이 아니에요", status: 409 };
    const role = roleOf(data, uid);
    if (!role) return { error: "이 방의 플레이어가 아니에요", status: 403 };
    if (role === "challenger" && !data.challengerId) return { error: "도전자 슬롯이 비어있어요", status: 409 };

    const field = role === "host" ? "hostReady" : "challengerReady";
    const update = { [field]: ready };

    const otherReady = role === "host" ? data.challengerReady : data.hostReady;
    const bothReady = data.challengerId && ready && otherReady;

    if (bothReady) {
      let hostColor;
      if (data.firstMoveRule === "host") hostColor = "white";
      else if (data.firstMoveRule === "challenger") hostColor = "black";
      else hostColor = Math.random() < 0.5 ? "white" : "black";
      const challengerColor = hostColor === "white" ? "black" : "white";

      const presetSeconds = data.timeControl && data.timeControl.presetSeconds;
      update.status = "playing";
      update.hostColor = hostColor;
      update.challengerColor = challengerColor;
      update.fen = START_FEN;
      update.moves = [];
      update.turn = "white";
      update.lastMove = null;
      update.turnStartedAt = new Date().toISOString();
      update.whiteTimeLeft = presetSeconds || null;
      update.blackTimeLeft = presetSeconds || null;
      update.hostLastSeenAt = new Date().toISOString();
      update.challengerLastSeenAt = new Date().toISOString();
      update.undoRequest = null;
      update.hostUndoUsed = 0;
      update.challengerUndoUsed = 0;
    }
    return { update };
  });
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true, status: result.data.status });
}

/* =========================================================
   /api/leave  - 본인 의사로 나가기(대기중 처리 or 기권)
========================================================= */
async function handleLeave(request, env) {
  let uid, roomId;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);

  const result = await withRoomTransaction(env, roomId, (data) => {
    const role = roleOf(data, uid);
    if (!role) return { noop: true }; // 관전자는 서버에 남길 상태가 없음

    if (data.status === "waiting") {
      if (role === "host") return { delete: true };
      return { update: { challengerId: null, challengerReady: false } };
    }

    const leftField = role === "host" ? "hostLeft" : "challengerLeft";
    const otherLeftField = role === "host" ? "challengerLeft" : "hostLeft";

    // 상대도 이미 나갔다면(먼저 나가면서 finished 처리만 되고 방은 안 지워졌던 상태) 볼 사람이
    // 아무도 없으니 방 자체를 삭제. 이게 "둘 다 나가도 방이 안 지워지는" 버그의 수정 지점.
    if (data[otherLeftField]) {
      return { delete: true };
    }

    if (data.status === "playing") {
      const myColor = colorOf(data, role);
      const winner = myColor === "white" ? "black" : "white";
      return {
        update: {
          [leftField]: true,
          status: "finished",
          resultStatus: "left",
          winner,
          gameOverAt: new Date().toISOString(),
        },
      };
    }
    // 이미 finished인 방에서 나가는 경우: 내가 나갔다는 사실만 기록.
    // 나중에 상대도 나가면 위의 otherLeftField 분기에서 방이 지워짐.
    return { update: { [leftField]: true } };
  });
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true, deleted: !!result.deleted });
}

/* =========================================================
   /api/claim-idle
   - 방 안의 누구든(한 명이라도) 실제 활동(버튼/기물 클릭)이 10분 넘게 없으면
     방을 통째로 삭제. 클라이언트 주장이 아니라 서버가 hostLastActionAt /
     challengerLastActionAt 타임스탬프로 직접 재확인함.
========================================================= */
async function handleClaimIdle(request, env) {
  let uid, roomId;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);

  const result = await withRoomTransaction(env, roomId, (data) => {
    const role = roleOf(data, uid);
    if (!role) return { error: "이 방의 플레이어가 아니에요", status: 403 };

    const now = Date.now();
    const isIdle = (field) => {
      const t = data[field] ? Date.parse(data[field]) : null;
      return !t || now - t > IDLE_THRESHOLD_MS;
    };
    const hostIdle = data.hostId ? isIdle("hostLastActionAt") : false;
    const challengerIdle = data.challengerId ? isIdle("challengerLastActionAt") : false;

    if (!hostIdle && !challengerIdle) {
      return { error: "아직 방치 상태로 확인되지 않아요", status: 409 };
    }
    return { delete: true };
  });
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true, deleted: !!result.deleted });
}
async function handleResign(request, env) {
  let uid, roomId;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);

  const result = await withRoomTransaction(env, roomId, (data) => {
    if (data.status !== "playing") return { error: "게임 중인 방이 아니에요", status: 409 };
    const role = roleOf(data, uid);
    if (!role) return { error: "이 방의 플레이어가 아니에요", status: 403 };
    const myColor = colorOf(data, role);
    const winner = myColor === "white" ? "black" : "white";
    return {
      update: {
        status: "finished",
        resultStatus: "resign",
        winner,
        gameOverAt: new Date().toISOString(),
      },
    };
  });
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true });
}

/* =========================================================
   /api/claim-disconnect
   - 상대의 하트비트가 25초 이상 끊겼을 때만 서버가 인정
   - 클라이언트의 "상대 끊겼다" 주장을 그대로 믿지 않고 타임스탬프로 검증
========================================================= */
const DISCONNECT_THRESHOLD_MS = 30000; // 재접속 유예 30초
const IDLE_THRESHOLD_MS = 10 * 60 * 1000; // 방치 판정 10분

async function handleClaimDisconnect(request, env) {
  let uid, roomId;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);

  const result = await withRoomTransaction(env, roomId, (data) => {
    const role = roleOf(data, uid);
    if (!role) return { error: "이 방의 플레이어가 아니에요", status: 403 };
    const oppRole = role === "host" ? "challenger" : "host";
    const oppSeenField = oppRole === "host" ? "hostLastSeenAt" : "challengerLastSeenAt";
    const oppSeenAt = data[oppSeenField] ? Date.parse(data[oppSeenField]) : null;

    if (!oppSeenAt || Date.now() - oppSeenAt < DISCONNECT_THRESHOLD_MS) {
      return { error: "아직 상대의 연결 끊김이 확인되지 않아요", status: 409 };
    }

    if (data.status === "waiting") {
      if (role === "challenger" && oppRole === "host") return { delete: true };
      if (role === "host" && oppRole === "challenger") {
        return { update: { challengerId: null, challengerReady: false } };
      }
      return { noop: true };
    }
    if (data.status === "playing") {
      const myColor = colorOf(data, role);
      const winner = myColor === "white" ? "black" : "white";
      return {
        update: {
          status: "finished",
          resultStatus: "left",
          winner,
          gameOverAt: new Date().toISOString(),
        },
      };
    }
    return { noop: true };
  });
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true, deleted: !!result.deleted });
}

/* =========================================================
   /api/claim-timeout  - 시간 초과 판정
========================================================= */
async function handleClaimTimeout(request, env) {
  let uid, roomId;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);

  const result = await withRoomTransaction(env, roomId, (data) => {
    if (data.status !== "playing") return { error: "게임 중인 방이 아니에요", status: 409 };
    const role = roleOf(data, uid);
    if (!role) return { error: "이 방의 플레이어가 아니에요", status: 403 };
    if (!data.timeControl || !data.timeControl.presetSeconds) {
      return { error: "무제한 시간 방이에요", status: 409 };
    }

    const startedAtMillis = data.turnStartedAt ? Date.parse(data.turnStartedAt) : Date.now();
    const elapsedSec = Math.max(0, (Date.now() - startedAtMillis) / 1000);
    const field = data.turn === "white" ? "whiteTimeLeft" : "blackTimeLeft";
    const baseLeft = typeof data[field] === "number" ? data[field] : data.timeControl.presetSeconds;
    const remaining = baseLeft - elapsedSec;

    if (remaining > 0) return { error: "아직 시간이 남아있어요", status: 409 };

    const timedOutColor = data.turn; // 시간이 다 된 쪽
    const winner = timedOutColor === "white" ? "black" : "white";
    return {
      update: {
        status: "finished",
        resultStatus: "timeout",
        winner,
        [field]: 0,
        gameOverAt: new Date().toISOString(),
      },
    };
  });
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true });
}

/* =========================================================
   /api/undo-request  - 무르기 요청
   - 서버가 undoLimit(호스트/도전자 각자 사용 횟수)과 진행 상태를 검증하고
     room 문서에 undoRequest만 기록함(실제 되돌리기는 상대가 수락해야 발생)
========================================================= */
async function handleUndoRequest(request, env) {
  let uid, roomId;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);

  const result = await withRoomTransaction(env, roomId, (data) => {
    if (data.status !== "playing") return { error: "게임 중인 방이 아니에요", status: 409 };
    const role = roleOf(data, uid);
    if (!role) return { error: "이 방의 플레이어가 아니에요", status: 403 };
    if (data.undoRequest) return { error: "이미 진행 중인 무르기 요청이 있어요", status: 409 };

    const myColor = colorOf(data, role);
    if (data.turn === myColor) {
      return { error: "본인 턴에는 요청할 수 없어요 (방금 둔 직후, 상대 턴일 때만 가능)", status: 409 };
    }

    const moves = data.moves || [];
    if (moves.length === 0) return { error: "되돌릴 수가 없어요", status: 409 };

    const usedField = role === "host" ? "hostUndoUsed" : "challengerUndoUsed";
    const used = data[usedField] || 0;
    if (data.undoLimit !== -1 && used >= data.undoLimit) {
      return { error: "무르기 횟수를 다 사용했어요", status: 409 };
    }

    return {
      update: {
        undoRequest: { by: role, requestedAt: new Date().toISOString() },
      },
    };
  });
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true });
}

/* =========================================================
   /api/undo-respond  - 무르기 요청에 대한 상대의 수락/거절
   - 수락 시 서버가 마지막 수를 잘라내고 처음부터 재생해서 fen/turn을 다시 계산함
   - 요청자의 사용 횟수는 "수락됐을 때만" 차감(거절되면 그대로 유지)
========================================================= */
async function handleUndoRespond(request, env) {
  let uid, roomId, accept;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
    accept = !!body.accept;
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);

  const result = await withRoomTransaction(env, roomId, (data) => {
    if (data.status !== "playing") return { error: "게임 중인 방이 아니에요", status: 409 };
    const role = roleOf(data, uid);
    if (!role) return { error: "이 방의 플레이어가 아니에요", status: 403 };
    if (!data.undoRequest) return { error: "무르기 요청이 없어요", status: 409 };
    if (accept && data.undoRequest.by === role) {
      return { error: "본인 요청은 수락할 수 없어요", status: 403 };
    }

    if (!accept) {
      return { update: { undoRequest: null } };
    }

    const moves = (data.moves || []).slice(0, -1);
    const replayed = replayMoves(moves);
    const requesterUsedField = data.undoRequest.by === "host" ? "hostUndoUsed" : "challengerUndoUsed";
    const requesterUsed = (data[requesterUsedField] || 0) + 1;

    return {
      update: {
        moves,
        fen: replayed.fen,
        turn: replayed.turn,
        lastMove: replayed.lastMove,
        turnStartedAt: new Date().toISOString(),
        undoRequest: null,
        [requesterUsedField]: requesterUsed,
      },
    };
  });
  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true, accepted: accept });
}

/* =========================================================
   /api/move
========================================================= */
async function handleMove(request, env) {
  let uid, roomId, from, to, promotion;
  try {
    const { uid: u, body } = await requireAuth(request, env);
    uid = u;
    roomId = body.roomId;
    from = body.from;
    to = body.to;
    promotion = body.promotion;
  } catch (e) {
    return json({ ok: false, error: e.message }, e.status);
  }
  if (!roomId || !from || !to) {
    return json({ ok: false, error: "필수 파라미터 누락" }, 400);
  }

  let sanOut = null;
  let fenOut = null;
  let statusOut = "playing";

  const result = await withRoomTransaction(env, roomId, (data) => {
    if (data.status !== "playing") return { error: "게임 중인 방이 아니에요", status: 409 };
    const role = roleOf(data, uid);
    const myColor = colorOf(data, role);
    if (!myColor) return { error: "이 방의 플레이어가 아니에요", status: 403 };
    if (data.turn !== myColor) return { error: "당신의 차례가 아니에요", status: 409 };

    const game = new Chess();
    try {
      game.load(data.fen);
    } catch (e) {
      return { error: "서버에 저장된 기보 손상", status: 500 };
    }

    let moveResult;
    try {
      moveResult = game.move({ from, to, promotion: promotion || "q" });
    } catch (e) {
      moveResult = null;
    }
    if (!moveResult) return { error: "합법적이지 않은 수예요", status: 400 };

    const newFen = game.fen();
    const moves = [...(data.moves || []), moveResult.lan];

    const update = {
      fen: newFen,
      moves,
      turn: game.turn() === "w" ? "white" : "black",
      lastMove: {
        from: moveResult.from,
        to: moveResult.to,
        promotion: moveResult.promotion || null,
        san: moveResult.san,
      },
    };

    const presetSeconds = data.timeControl && data.timeControl.presetSeconds;
    if (presetSeconds) {
      const incrementSeconds = (data.timeControl && data.timeControl.incrementSeconds) || 0;
      const startedAtMillis = data.turnStartedAt ? Date.parse(data.turnStartedAt) : Date.now();
      const elapsedSec = Math.max(0, (Date.now() - startedAtMillis) / 1000);
      const field = data.turn === "white" ? "whiteTimeLeft" : "blackTimeLeft";
      const currentLeft = typeof data[field] === "number" ? data[field] : presetSeconds;
      update[field] = Math.max(0, currentLeft - elapsedSec + incrementSeconds);
    }
    update.turnStartedAt = new Date().toISOString();
    update.undoRequest = null;

    if (game.isCheckmate()) {
      update.status = "finished";
      update.resultStatus = "checkmate";
      update.winner = data.turn;
      update.gameOverAt = new Date().toISOString();
    } else if (game.isStalemate()) {
      update.status = "finished";
      update.resultStatus = "stalemate";
      update.winner = null;
      update.gameOverAt = new Date().toISOString();
    } else if (game.isThreefoldRepetition()) {
      update.status = "finished";
      update.resultStatus = "threefold";
      update.winner = null;
      update.gameOverAt = new Date().toISOString();
    } else if (game.isInsufficientMaterial()) {
      update.status = "finished";
      update.resultStatus = "insufficient";
      update.winner = null;
      update.gameOverAt = new Date().toISOString();
    } else if (game.isDrawByFiftyMoves()) {
      update.status = "finished";
      update.resultStatus = "50move";
      update.winner = null;
      update.gameOverAt = new Date().toISOString();
    }

    sanOut = moveResult.san;
    fenOut = newFen;
    statusOut = update.status || "playing";
    return { update };
  });

  if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true, fen: fenOut, san: sanOut, status: statusOut });
}

/* =========================================================
   /api/admin-delete  - 관리자 방 삭제
========================================================= */
async function handleAdminDelete(request, env) {
  const body = await request.json();
  const { roomId, password } = body || {};
  if (!roomId) return json({ ok: false, error: "roomId 누락" }, 400);
  const ok = await checkAdminPassword(env, password);
  if (!ok) return json({ ok: false, error: "관리자 인증 실패" }, 401);

  const accessToken = await getFirestoreAccessToken(env);
  const doc = await firestoreGet(env, roomId, accessToken);
  if (!doc) return json({ ok: true, deleted: true }); // 이미 없음

  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = attempt === 0 ? doc : await firestoreGet(env, roomId, accessToken);
    if (!fresh) return json({ ok: true, deleted: true });
    const del = await firestoreConditionalDelete(env, accessToken, fresh.name, fresh.updateTime);
    if (del.conflict) continue;
    return json({ ok: true, deleted: true });
  }
  return json({ ok: false, error: "삭제 충돌, 다시 시도해주세요" }, 409);
}

/* =========================================================
   방치 방 자동 정리 (Cron Trigger 전용)
   - 클라이언트(브라우저 탭)가 하나도 안 남아있으면 /api/claim-idle을 호출해줄
     사람 자체가 없어서, 이건 브라우저 없이 서버 스스로 도는 청소 작업임.
   - Cloudflare 대시보드에서 이 워커에 Cron Trigger를 추가해야 실제로 동작함.
========================================================= */
async function cleanupIdleRooms(env) {
  const accessToken = await getFirestoreAccessToken(env);
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${(env.FIREBASE_PROJECT_ID || "").trim()}/databases/(default)/documents/rooms`;
  const now = Date.now();
  let pageToken;

  do {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      console.error("[cleanup] 방 목록 조회 실패:", await res.text());
      return;
    }
    const body = await res.json();
    const docs = body.documents || [];

    for (const doc of docs) {
      const data = docToJs(doc);
      const isStale = (field) => {
        const t = data[field] ? Date.parse(data[field]) : null;
        return !t || now - t > IDLE_THRESHOLD_MS;
      };
      const hostIdle = data.hostId ? isStale("hostLastActionAt") : false;
      const challengerIdle = data.challengerId ? isStale("challengerLastActionAt") : false;
      const shouldDelete =
        (data.status === "waiting" || data.status === "playing") && (hostIdle || challengerIdle);

      if (shouldDelete) {
        try {
          await firestoreConditionalDelete(env, accessToken, doc.name, doc.updateTime);
        } catch (e) {
          console.error("[cleanup] 방 삭제 실패:", doc.name, e.message);
        }
      }
    }

    pageToken = body.nextPageToken;
  } while (pageToken);
}

/* =========================================================
   라우팅
========================================================= */
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);

    try {
      if (request.method !== "POST") return json({ ok: false, error: "not found" }, 404);
      switch (url.pathname) {
        case "/api/verify-admin":
          return await handleVerifyAdmin(request, env);
        case "/api/join":
          return await handleJoin(request, env);
        case "/api/heartbeat":
          return await handleHeartbeat(request, env);
        case "/api/ready":
          return await handleReady(request, env);
        case "/api/leave":
          return await handleLeave(request, env);
        case "/api/resign":
          return await handleResign(request, env);
        case "/api/claim-disconnect":
          return await handleClaimDisconnect(request, env);
        case "/api/claim-idle":
          return await handleClaimIdle(request, env);
        case "/api/claim-timeout":
          return await handleClaimTimeout(request, env);
        case "/api/undo-request":
          return await handleUndoRequest(request, env);
        case "/api/undo-respond":
          return await handleUndoRespond(request, env);
        case "/api/move":
          return await handleMove(request, env);
        case "/api/admin-delete":
          return await handleAdminDelete(request, env);
        default:
          return json({ ok: false, error: "not found" }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: "서버 오류: " + e.message }, 500);
    }
  },

  // Cloudflare 대시보드 → Settings → Trigger events에서 Cron Trigger를 추가해야 실제로 호출됨
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupIdleRooms(env));
  },
};
