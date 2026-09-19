import { clearTracks, deleteTrack, getTracks, saveTrack } from "./db.js";
import { AudioPlayer, formatClock, hashHue, parseId3 } from "./player.js";
import { formatDuration, formatPace, RunSession, WakeLock } from "./run.js";

const els = {
  gpsBadge: document.getElementById("gps-badge"),
  installBtn: document.getElementById("install-btn"),
  time: document.getElementById("time-display"),
  distance: document.getElementById("distance-display"),
  pace: document.getElementById("pace-display"),
  avgPace: document.getElementById("avg-pace-display"),
  artwork: document.getElementById("artwork"),
  title: document.getElementById("track-title"),
  artist: document.getElementById("track-artist"),
  seek: document.getElementById("seek"),
  currentTime: document.getElementById("current-time"),
  duration: document.getElementById("duration-time"),
  shuffle: document.getElementById("shuffle-btn"),
  prev: document.getElementById("prev-btn"),
  play: document.getElementById("play-btn"),
  playIcon: document.getElementById("play-icon"),
  pauseIcon: document.getElementById("pause-icon"),
  next: document.getElementById("next-btn"),
  repeat: document.getElementById("repeat-btn"),
  start: document.getElementById("start-btn"),
  activeActions: document.getElementById("active-actions"),
  pauseRun: document.getElementById("pause-run-btn"),
  lap: document.getElementById("lap-btn"),
  lock: document.getElementById("lock-btn"),
  finish: document.getElementById("finish-btn"),
  addMusic: document.getElementById("add-music-btn"),
  clearLibrary: document.getElementById("clear-library-btn"),
  fileInput: document.getElementById("file-input"),
  trackList: document.getElementById("track-list"),
  libraryCount: document.getElementById("library-count"),
  lapList: document.getElementById("lap-list"),
  lockScreen: document.getElementById("lock-screen"),
  lockTime: document.getElementById("lock-time"),
  lockDistance: document.getElementById("lock-distance"),
  lockTrack: document.getElementById("lock-track"),
  lockPlay: document.getElementById("lock-play-btn"),
  lockPlayIcon: document.getElementById("lock-play-icon"),
  lockPauseIcon: document.getElementById("lock-pause-icon"),
  unlock: document.getElementById("unlock-btn"),
  summary: document.getElementById("summary-sheet"),
  summaryTime: document.getElementById("summary-time"),
  summaryDistance: document.getElementById("summary-distance"),
  summaryPace: document.getElementById("summary-pace"),
  summaryLaps: document.getElementById("summary-laps"),
  summaryClose: document.getElementById("summary-close"),
  installSheet: document.getElementById("install-sheet"),
  installClose: document.getElementById("install-close"),
  audio: document.getElementById("audio")
};

const player = new AudioPlayer(els.audio);
const run = new RunSession();
const wakeLock = new WakeLock();
let seeking = false;
let runStarted = false;
let unlockTimer = 0;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function renderPlayer() {
  const track = player.current;
  const playing = !els.audio.paused && !els.audio.ended;
  els.playIcon.classList.toggle("hidden", playing);
  els.pauseIcon.classList.toggle("hidden", !playing);
  els.lockPlayIcon.classList.toggle("hidden", playing);
  els.lockPauseIcon.classList.toggle("hidden", !playing);
  els.play.setAttribute("aria-label", playing ? "Pause" : "Play");
  els.shuffle.setAttribute("aria-pressed", String(player.shuffle));
  els.repeat.setAttribute("aria-pressed", String(player.repeat));

  if (!track) {
    els.title.textContent = "Add your run playlist";
    els.artist.textContent = "MP3s stay on this phone";
    els.artwork.textContent = "♪";
    els.artwork.style.background = "var(--lime)";
    els.lockTrack.textContent = "No track";
    return;
  }

  els.title.textContent = track.title;
  els.artist.textContent = track.artist || "Unknown artist";
  els.artwork.textContent = track.title.slice(0, 1).toUpperCase();
  els.artwork.style.background = `hsl(${hashHue(track.title)} 72% 62%)`;
  els.lockTrack.textContent = track.title;
}

function renderLibrary() {
  const count = player.tracks.length;
  els.libraryCount.textContent = count ? `${count} track${count === 1 ? "" : "s"}` : "No tracks yet";
  els.trackList.innerHTML = "";
  player.tracks.forEach((track, index) => {
    const item = document.createElement("li");
    if (player.current?.id === track.id) item.classList.add("active");
    item.innerHTML = `
      <button class="track-pick" type="button">
        <span class="name">${escapeHtml(track.title)}</span>
        <span class="meta">${escapeHtml(track.artist || "Unknown artist")}</span>
      </button>
      <button class="delete-track" type="button" aria-label="Remove ${escapeHtml(track.title)}">✕</button>
    `;
    item.querySelector(".track-pick").addEventListener("click", () => player.load(index, true));
    item.querySelector(".delete-track").addEventListener("click", async () => {
      await deleteTrack(track.id);
      await reloadTracks(player.current?.id);
    });
    els.trackList.appendChild(item);
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function renderRun() {
  const elapsed = formatDuration(run.elapsed);
  const km = run.distance / 1000;
  els.time.textContent = elapsed;
  els.lockTime.textContent = elapsed;
  els.distance.innerHTML = `${km.toFixed(2)}<span>km</span>`;
  els.lockDistance.textContent = `${km.toFixed(2)} km`;
  els.pace.innerHTML = `${formatPace(run.currentPace)}<span>/km</span>`;
  els.avgPace.innerHTML = `${formatPace(run.averagePace)}<span>/km</span>`;
  document.body.classList.toggle("running", run.running);

  if (runStarted) {
    els.start.classList.add("hidden");
    els.activeActions.classList.remove("hidden");
    els.pauseRun.textContent = run.running ? "Pause" : "Resume";
  } else {
    els.start.classList.remove("hidden");
    els.activeActions.classList.add("hidden");
  }

  if (!run.laps.length) {
    els.lapList.hidden = true;
    els.lapList.innerHTML = "";
    return;
  }

  els.lapList.hidden = false;
  els.lapList.innerHTML = run.laps
    .map((lap, index) => {
      const prev = run.laps[index - 1];
      const split = formatDuration(lap.time - (prev?.time || 0));
      return `<li>Lap ${index + 1} · ${split} · ${(lap.distance / 1000).toFixed(2)} km</li>`;
    })
    .join("");
}

function renderGps(status) {
  const labels = {
    off: "GPS off",
    seeking: "Finding GPS",
    live: "GPS live",
    weak: "GPS weak",
    paused: "GPS paused",
    denied: "GPS blocked",
    unavailable: "No GPS"
  };
  els.gpsBadge.textContent = labels[status] || "GPS off";
  els.gpsBadge.classList.toggle("live", status === "live");
  els.gpsBadge.classList.toggle("warn", status === "denied" || status === "weak" || status === "unavailable");
}

function tickAudio() {
  if (seeking) return;
  const { currentTime, duration } = els.audio;
  els.currentTime.textContent = formatClock(currentTime);
  els.duration.textContent = formatClock(duration);
  if (Number.isFinite(duration) && duration > 0) {
    els.seek.value = String(Math.round((currentTime / duration) * 1000));
  }
}

async function reloadTracks(preferredId) {
  const tracks = await getTracks();
  const exists = tracks.some((track) => track.id === preferredId);
  player.setTracks(tracks, exists ? preferredId : tracks[0]?.id);
  renderLibrary();
  renderPlayer();
  if (!tracks.length) {
    player.pause();
    if (player.objectUrl) URL.revokeObjectURL(player.objectUrl);
    player.objectUrl = "";
    els.audio.removeAttribute("src");
    els.audio.load();
    els.seek.value = "0";
    els.currentTime.textContent = "0:00";
    els.duration.textContent = "0:00";
    return;
  }
  if (!exists || !els.audio.src) await player.load(player.index, false);
}

async function addFiles(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav)$/i.test(file.name));
  for (const file of files) {
    const tags = await parseId3(file);
    await saveTrack({
      id: uid(),
      title: tags.title,
      artist: tags.artist,
      blob: file,
      addedAt: Date.now()
    });
  }
  await reloadTracks(player.current?.id);
}

async function startRun() {
  runStarted = true;
  run.start();
  await wakeLock.request();
  renderRun();
}

async function pauseOrResume() {
  if (run.running) {
    run.pause();
    await wakeLock.release();
  } else {
    run.start();
    await wakeLock.request();
  }
  renderRun();
}

function finishRun() {
  run.pause();
  const snapshot = run.snapshot();
  els.summaryTime.textContent = snapshot.time;
  els.summaryDistance.textContent = `${snapshot.distanceKm.toFixed(2)} km`;
  els.summaryPace.textContent = `${snapshot.pace} /km`;
  els.summaryLaps.textContent = String(snapshot.laps);
  showOverlay(els.summary);
  hideOverlay(els.lockScreen);
  runStarted = false;
  run.reset();
  wakeLock.release();
  renderRun();
}

player.onChange = () => {
  renderPlayer();
  renderLibrary();
};

run.onUpdate = renderRun;
run.onGps = renderGps;

els.addMusic.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", async () => {
  await addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.clearLibrary.addEventListener("click", async () => {
  if (!player.tracks.length) return;
  if (!confirm("Remove all tracks from this phone?")) return;
  player.pause();
  els.audio.removeAttribute("src");
  await clearTracks();
  await reloadTracks();
});
els.play.addEventListener("click", () => player.toggle());
els.lockPlay.addEventListener("click", () => player.toggle());
els.next.addEventListener("click", () => player.next(!els.audio.paused));
els.prev.addEventListener("click", () => player.prev());
els.shuffle.addEventListener("click", () => {
  player.shuffle = !player.shuffle;
  renderPlayer();
});
els.repeat.addEventListener("click", () => {
  player.repeat = !player.repeat;
  renderPlayer();
});
els.seek.addEventListener("input", () => {
  seeking = true;
  player.seekRatio(Number(els.seek.value) / 1000);
});
els.seek.addEventListener("change", () => {
  seeking = false;
});
els.audio.addEventListener("timeupdate", tickAudio);
els.audio.addEventListener("loadedmetadata", tickAudio);
els.audio.addEventListener("play", renderPlayer);
els.audio.addEventListener("pause", renderPlayer);
els.audio.addEventListener("ended", () => {
  if (player.repeat) {
    els.audio.currentTime = 0;
    player.play();
    return;
  }
  player.next(true);
});
els.start.addEventListener("click", startRun);
els.pauseRun.addEventListener("click", pauseOrResume);
els.lap.addEventListener("click", () => run.lap());
els.finish.addEventListener("click", finishRun);
function showOverlay(el) {
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
}

function hideOverlay(el) {
  el.classList.add("hidden");
  el.setAttribute("aria-hidden", "true");
}

els.lock.addEventListener("click", () => showOverlay(els.lockScreen));
els.unlock.addEventListener("pointerdown", () => {
  els.unlock.classList.add("holding");
  unlockTimer = window.setTimeout(() => {
    hideOverlay(els.lockScreen);
    els.unlock.classList.remove("holding");
  }, 650);
});
["pointerup", "pointerleave", "pointercancel"].forEach((eventName) => {
  els.unlock.addEventListener(eventName, () => {
    window.clearTimeout(unlockTimer);
    els.unlock.classList.remove("holding");
  });
});
els.summaryClose.addEventListener("click", () => hideOverlay(els.summary));
els.installBtn.addEventListener("click", () => showOverlay(els.installSheet));
els.installClose.addEventListener("click", () => {
  hideOverlay(els.installSheet);
  localStorage.setItem("stride-install-seen", "1");
});
els.gpsBadge.addEventListener("click", () => {
  if (!runStarted) startRun();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && run.running) wakeLock.request();
  renderRun();
});

setInterval(() => {
  if (runStarted) renderRun();
}, 200);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

if (!localStorage.getItem("stride-install-seen") && !window.navigator.standalone) {
  showOverlay(els.installSheet);
}

reloadTracks();
renderRun();
renderGps("off");
