export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatPace(secondsPerKm) {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0 || secondsPerKm > 3600) return "--:--";
  const m = Math.floor(secondsPerKm / 60);
  const s = Math.round(secondsPerKm % 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

function haversine(a, b) {
  const earth = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(x)));
}

export class RunSession {
  constructor() {
    this.accumulated = 0;
    this.startedAt = null;
    this.distance = 0;
    this.lastPoint = null;
    this.watchId = null;
    this.laps = [];
    this.samples = [];
    this.gpsStatus = "off";
    this.onUpdate = () => {};
    this.onGps = () => {};
  }

  get elapsed() {
    return this.accumulated + (this.startedAt ? Date.now() - this.startedAt : 0);
  }

  get running() {
    return this.startedAt !== null;
  }

  get currentPace() {
    const cutoff = Date.now() - 25000;
    const recent = this.samples.filter((sample) => sample.t >= cutoff);
    if (recent.length < 2) return null;
    const dist = recent.at(-1).d - recent[0].d;
    const time = (recent.at(-1).t - recent[0].t) / 1000;
    if (dist < 15 || time < 5) return null;
    return time / (dist / 1000);
  }

  get averagePace() {
    if (this.distance < 30) return null;
    return this.elapsed / 1000 / (this.distance / 1000);
  }

  start() {
    if (this.running) return;
    this.startedAt = Date.now();
    this.startGps();
    this.onUpdate();
  }

  pause() {
    if (!this.running) return;
    this.accumulated = this.elapsed;
    this.startedAt = null;
    this.stopGps();
    this.gpsStatus = this.distance > 0 ? "paused" : "off";
    this.onGps(this.gpsStatus);
    this.onUpdate();
  }

  lap() {
    this.laps.push({
      time: this.elapsed,
      distance: this.distance
    });
    this.onUpdate();
  }

  reset() {
    this.pause();
    this.accumulated = 0;
    this.distance = 0;
    this.lastPoint = null;
    this.laps = [];
    this.samples = [];
    this.gpsStatus = "off";
    this.onGps(this.gpsStatus);
    this.onUpdate();
  }

  startGps() {
    if (!navigator.geolocation) {
      this.gpsStatus = "unavailable";
      this.onGps(this.gpsStatus);
      return;
    }
    this.stopGps();
    this.gpsStatus = "seeking";
    this.onGps(this.gpsStatus);
    this.watchId = navigator.geolocation.watchPosition(
      (position) => this.acceptFix(position),
      () => {
        this.gpsStatus = "denied";
        this.onGps(this.gpsStatus);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 15000
      }
    );
  }

  stopGps() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  acceptFix(position) {
    const { latitude, longitude, accuracy } = position.coords;
    if (accuracy > 45) {
      this.gpsStatus = "weak";
      this.onGps(this.gpsStatus);
      return;
    }

    const point = { lat: latitude, lon: longitude, t: Date.now() };
    if (this.lastPoint) {
      const delta = haversine(this.lastPoint, point);
      const dt = (point.t - this.lastPoint.t) / 1000;
      const speed = dt > 0 ? delta / dt : 0;
      if (delta >= 4 && speed < 12) {
        this.distance += delta;
        this.samples.push({ t: point.t, d: this.distance });
        if (this.samples.length > 80) this.samples.shift();
      }
    }

    this.lastPoint = point;
    this.gpsStatus = "live";
    this.onGps(this.gpsStatus);
    this.onUpdate();
  }

  snapshot() {
    return {
      time: formatDuration(this.elapsed),
      distanceKm: this.distance / 1000,
      pace: formatPace(this.averagePace),
      laps: this.laps.length
    };
  }
}

export class Countdown {
  constructor() {
    this.duration = 0;
    this.remaining = 0;
    this.startedAt = null;
    this.finished = false;
    this.beeped = false;
    this.onZero = () => {};
  }

  get running() {
    return this.startedAt !== null;
  }

  get left() {
    if (!this.startedAt) return this.remaining;
    return Math.max(0, this.remaining - (Date.now() - this.startedAt));
  }

  set(ms) {
    this.duration = Math.max(0, ms);
    this.remaining = this.duration;
    this.startedAt = null;
    this.finished = false;
    this.beeped = false;
  }

  start() {
    if (this.duration <= 0 || this.finished || this.running) return;
    this.startedAt = Date.now();
  }

  pause() {
    if (!this.running) return;
    this.remaining = this.left;
    this.startedAt = null;
    if (this.remaining <= 0) this.finish();
  }

  finish() {
    this.startedAt = null;
    this.remaining = 0;
    this.finished = true;
    if (!this.beeped) {
      this.beeped = true;
      this.onZero();
    }
  }

  checkZero() {
    if (this.running && this.left <= 0) this.finish();
  }

  reset() {
    this.set(this.duration);
  }
}

let beepContext = null;

export function unlockBeep() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  if (!beepContext) beepContext = new AudioCtx();
  if (beepContext.state === "suspended") beepContext.resume();
}

export function playZeroBeep() {
  unlockBeep();
  if (!beepContext) return;

  const ctx = beepContext;
  const now = ctx.currentTime;
  const hits = [0, 0.32, 0.64, 1.05];

  hits.forEach((offset, index) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = index === hits.length - 1 ? 660 : 880;
    const start = now + offset;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.28, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.24);
  });

  try {
    navigator.vibrate?.([200, 80, 200, 80, 280]);
  } catch {
    /* ignore */
  }
}

export class WakeLock {
  constructor() {
    this.sentinel = null;
  }

  async request() {
    try {
      if (document.visibilityState !== "visible") return;
      this.sentinel = await navigator.wakeLock?.request("screen");
      if (this.sentinel) {
        this.sentinel.addEventListener("release", () => {
          this.sentinel = null;
        });
      }
    } catch {
      this.sentinel = null;
    }
  }

  async release() {
    try {
      await this.sentinel?.release();
    } catch {
      /* ignore */
    }
    this.sentinel = null;
  }
}
