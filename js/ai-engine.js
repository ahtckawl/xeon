// Stockfish 엔진 로드/통신 부분만 chess_game_app_v3_5.html에서 그대로 가져온 모듈.
// (이 파일이 하는 일은 오직 "엔진 켜고 fen 넣으면 최선수 UCI 문자열 받기" 뿐이고,
//  힌트 모드 on/off, 좌표 변환 이후의 표시 로직은 room.js에 있음)

let engineWorker = null;
let engineReadyResolve = null;
let engineReadyPromise = new Promise((res) => { engineReadyResolve = res; });
let pendingMoveResolve = null;

export function initEngine() {
  if (engineWorker) return;
  fetch("https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js")
    .then((r) => r.text())
    .then((code) => {
      const blob = new Blob([code], { type: "application/javascript" });
      engineWorker = new Worker(URL.createObjectURL(blob));
      engineWorker.onmessage = handleEngineMessage;
      engineWorker.postMessage("uci");
    })
    .catch((err) => {
      console.error("Stockfish 엔진 로드 실패:", err);
    });
}

function handleEngineMessage(e) {
  const line = typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
  if (line === "uciok") {
    if (engineReadyResolve) { engineReadyResolve(); engineReadyResolve = null; }
  } else if (line.indexOf("bestmove") === 0) {
    const parts = line.split(" ");
    const moveStr = parts[1];
    if (pendingMoveResolve) { pendingMoveResolve(moveStr); pendingMoveResolve = null; }
  }
}

// UCI 좌표 문자열("e2e4")을 보드 배열 인덱스로 변환
export function uciToCoords(moveStr) {
  if (!moveStr || moveStr.length < 4) return null;
  const fromFile = moveStr.charCodeAt(0) - 97;
  const fromRank = 8 - parseInt(moveStr[1]);
  const toFile = moveStr.charCodeAt(2) - 97;
  const toRank = 8 - parseInt(moveStr[3]);
  return { from: { r: fromRank, c: fromFile }, to: { r: toRank, c: toFile } };
}

// fen을 넣으면 스톡피시가 생각한 최선수(uci 문자열)를 돌려줌
export function getAIMove(fen) {
  initEngine();
  return engineReadyPromise.then(() => {
    return new Promise((resolve) => {
      if (!engineWorker) { resolve(null); return; }
      pendingMoveResolve = resolve;
      engineWorker.postMessage("position fen " + fen);
      engineWorker.postMessage("go movetime 700");
    });
  });
}
