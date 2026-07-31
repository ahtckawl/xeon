// Cloudflare Worker(xeon-worker) API 호출 공통 헬퍼
import { auth, WORKER_BASE_URL } from "./firebase-config.js";

export async function callApi(path, body = {}) {
  let idToken = null;
  if (auth.currentUser) {
    idToken = await auth.currentUser.getIdToken();
  }
  const res = await fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, idToken }),
  });
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error("서버 응답을 읽지 못했어요");
  }
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `요청 실패 (${res.status})`);
  }
  return data;
}
