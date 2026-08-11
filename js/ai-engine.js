// Stockfish 엔진 로드/통신 부분. 실시간 "AI 힌트"(상대 몰래 최선수 추천)는 이제
// 클라이언트가 아니라 서버(worker.js의 /api/hint-move)가 처리하므로, 여기서는
// 더 이상 최선수 계산(getAIMove)을 하지 않음.
// 남아있는 getPositionEval은 "수 품질(✅🤫❌❓)" 사후 분석에만 쓰이는, 상대에게
// 불공정한 이점을 주지 않는 기능이라 그대로 클라이언트에 둠.

const ENGINE_LOAD_TIMEOUT_MS = 8000;
const ENGINE_MOVE_TIMEOUT_MS = 5000;

let engineWorker = null;
let engineLoadFailed = false;
let engineReadyResolve = null;
let engineReadyReject = null;
let engineReadyPromise = null;

let taskQueue = Promise.resolve();

// 요청마다 고유 ID를 붙여서, 타임아웃으로 이미 끝난 요청의 응답이 뒤늦게 도착해도
// "지금 진행 중인" 요청의 결과와 섞이지 않도록 함(이전엔 pending* 변수가 전역
// 하나뿐이라, 타임아웃 후 다음 요청이 시작된 뒤 이전 요청의 응답이 도착하면
// 엉뚱하게 다음 요청의 결과로 덮어써지는 버그가 있었음).
let requestSeq = 0;
let currentRequestId = null;
let pendingResolve = null;
let pendingScoreCp = null;
let pendingTimer = null;

function createReadyPromise() {
  engineReadyPromise = new Promise((res, rej) => {
    engineReadyResolve = res;
    engineReadyReject = rej;
  });
}
createReadyPromise();

export function initEngine() {
  if (engineWorker || engineLoadFailed) return;

  const loadTimer = setTimeout(() => {
    engineLoadFailed = true;
    if (engineReadyReject) engineReadyReject(new Error("엔진 로드 타임아웃"));
  }, ENGINE_LOAD_TIMEOUT_MS);

  fetch("https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js")
    .then((r) => r.text())
    .then((code) => {
      const blob = new Blob([code], { type: "application/javascript" });
      engineWorker = new Worker(URL.createObjectURL(blob));
      engineWorker.onmessage = handleEngineMessage;
      engineWorker.onerror = (err) => {
        clearTimeout(loadTimer);
        engineLoadFailed = true;
        console.error("Stockfish 워커 오류:", err);
        if (engineReadyReject) engineReadyReject(new Error("엔진 워커 오류"));
      };
      engineWorker.postMessage("uci");
    })
    .catch((err) => {
      clearTimeout(loadTimer);
      engineLoadFailed = true;
      console.error("Stockfish 엔진 로드 실패:", err);
      if (engineReadyReject) engineReadyReject(err);
    })
    .finally(() => {
      clearTimeout(loadTimer);
    });
}

function handleEngineMessage(e) {
  const line = typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";

  if (line === "uciok") {
    if (engineReadyResolve) { engineReadyResolve(); engineReadyResolve = null; engineReadyReject = null; }
    return;
  }

  if (line.indexOf("info") === 0 && line.indexOf(" score ") !== -1) {
    if (currentRequestId === null) return; // 지금 대기 중인 요청이 없으면 무시(늦게 도착한 이전 정보)
    const mateMatch = line.match(/score mate (-?\d+)/);
    const cpMatch = line.match(/score cp (-?\d+)/);
    if (mateMatch) {
      const m = parseInt(mateMatch[1], 10);
      pendingScoreCp = m > 0 ? 100000 - m : -100000 - m;
    } else if (cpMatch) {
      pendingScoreCp = parseInt(cpMatch[1], 10);
    }
    return;
  }

  if (line.indexOf("bestmove") === 0) {
    if (currentRequestId === null) return; // 타임아웃으로 이미 정리된 요청의 늦은 응답 -> 무시
    const parts = line.split(" ");
    const moveStr = parts[1];
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (pendingResolve) {
      pendingResolve({ moveStr, scoreCp: pendingScoreCp });
      pendingResolve = null;
    }
    pendingScoreCp = null;
    currentRequestId = null;
    return;
  }
}

// UCI 좌표 문자열("e2e4")을 보드 배열 인덱스로 변환 (서버가 돌려준 bestmove 표시에도 사용)
export function uciToCoords(moveStr) {
  if (!moveStr || moveStr.length < 4) return null;
  const fromFile = moveStr.charCodeAt(0) - 97;
  const fromRank = 8 - parseInt(moveStr[1]);
  const toFile = moveStr.charCodeAt(2) - 97;
  const toRank = 8 - parseInt(moveStr[3]);
  return { from: { r: fromRank, c: fromFile }, to: { r: toRank, c: toFile } };
}

function runEngineTask(fen, movetimeMs) {
  return engineReadyPromise
    .then(() => {
      return new Promise((resolve) => {
        if (!engineWorker) { resolve({ moveStr: null, scoreCp: null }); return; }

        const myRequestId = ++requestSeq;
        currentRequestId = myRequestId;
        pendingResolve = resolve;
        pendingScoreCp = null;

        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          // 이 타이머가 지금 진행 중인 요청 것이 맞을 때만 정리(이미 다음 요청이
          // 시작된 뒤라면 여긴 자기 자신이 끝난 뒤라 아무 것도 안 해야 함 -
          // 실제로는 requestId가 바뀌었으면 아래 currentRequestId 비교에서 걸러짐)
          if (currentRequestId !== myRequestId) return;
          // 엔진이 여전히 이 포지션을 계산 중일 수 있으니 멈추라고 알림.
          // stop 이후 도착하는 bestmove는 currentRequestId가 null이라 무시됨.
          if (engineWorker) engineWorker.postMessage("stop");
          currentRequestId = null;
          if (pendingResolve) { pendingResolve({ moveStr: null, scoreCp: null }); pendingResolve = null; }
        }, ENGINE_MOVE_TIMEOUT_MS);

        engineWorker.postMessage("position fen " + fen);
        engineWorker.postMessage("go movetime " + movetimeMs);
      });
    })
    .catch((err) => {
      console.error("[엔진] 준비 실패:", err.message);
      engineLoadFailed = false;
      createReadyPromise();
      return { moveStr: null, scoreCp: null };
    });
}

function queueEngineTask(fen, movetimeMs) {
  initEngine();
  const run = () => runEngineTask(fen, movetimeMs);
  const result = taskQueue.then(run, run);
  taskQueue = result.then(() => {}, () => {});
  return result;
}

// fen을 넣으면 "백 기준" 센티폰 평가값을 돌려줌(양수 = 백이 유리, 음수 = 흑이 유리).
// 실패하거나 값을 못 받으면 null. movetimeMs는 기본 300ms(수 품질 분류용 얕은 평가).
export function getPositionEval(fen, movetimeMs = 300) {
  return queueEngineTask(fen, movetimeMs).then((r) => {
    if (r.scoreCp === null || r.scoreCp === undefined) return null;
    const sideToMove = (fen.split(" ")[1] || "w");
    return sideToMove === "b" ? -r.scoreCp : r.scoreCp;
  });
}
