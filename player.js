function decodeId3Text(bytes) {
  if (!bytes.length) return "";
  const encoding = bytes[0];
  const data = bytes.slice(1);
  try {
    if (encoding === 0) return new TextDecoder("latin1").decode(data).replace(/\0/g, "").trim();
    if (encoding === 1) return new TextDecoder("utf-16").decode(data).replace(/\0/g, "").trim();
    if (encoding === 2) return new TextDecoder("utf-16be").decode(data).replace(/\0/g, "").trim();
    return new TextDecoder("utf-8").decode(data).replace(/\0/g, "").trim();
  } catch {
    return "";
  }
}

export async function parseId3(file) {
  const fallback = {
    title: file.name.replace(/\.[^.]+$/, ""),
    artist: ""
  };

  try {
    const headerBuf = await file.slice(0, 10).arrayBuffer();
    const header = new Uint8Array(headerBuf);
    if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return fallback;

    const size = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) | ((header[8] & 0x7f) << 7) | (header[9] & 0x7f);
    const body = new Uint8Array(await file.slice(10, 10 + Math.min(size, 256 * 1024)).arrayBuffer());
    const frames = {};
    let offset = 0;

    while (offset + 10 < body.length) {
      const id = String.fromCharCode(body[offset], body[offset + 1], body[offset + 2], body[offset + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const frameSize = (body[offset + 4] << 24) | (body[offset + 5] << 16) | (body[offset + 6] << 8) | body[offset + 7];
      if (frameSize <= 0 || offset + 10 + frameSize > body.length) break;
      frames[id] = decodeId3Text(body.slice(offset + 10, offset + 10 + frameSize));
      offset += 10 + frameSize;
    }

    return {
      title: frames.TIT2 || fallback.title,
      artist: frames.TPE1 || frames.TPE2 || fallback.artist
    };
  } catch {
    return fallback;
  }
}

export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function hashHue(text) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

export class AudioPlayer {
  constructor(audio) {
    this.audio = audio;
    this.tracks = [];
    this.index = 0;
    this.shuffle = false;
    this.repeat = false;
    this.objectUrl = "";
    this.onChange = () => {};
  }

  get current() {
    return this.tracks[this.index] || null;
  }

  setTracks(tracks, preferredId) {
    this.tracks = tracks;
    if (preferredId) {
      const found = tracks.findIndex((track) => track.id === preferredId);
      this.index = found >= 0 ? found : 0;
    } else if (this.index >= tracks.length) {
      this.index = 0;
    }
    this.onChange();
  }

  async load(index = this.index, autoplay = false) {
    if (!this.tracks[index]) return;
    this.index = index;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(this.tracks[index].blob);
    this.audio.src = this.objectUrl;
    this.audio.load();
    this.onChange();
    if (autoplay) await this.play();
  }

  async play() {
    if (!this.current) return;
    if (!this.audio.src) await this.load(this.index, false);
    try {
      await this.audio.play();
    } catch {
      /* iPhone needs a tap; the next user gesture will start playback */
    }
    this.syncMediaSession();
    this.onChange();
  }

  pause() {
    this.audio.pause();
    this.onChange();
  }

  toggle() {
    return this.audio.paused ? this.play() : this.pause();
  }

  async next(autoplay = true) {
    if (!this.tracks.length) return;
    if (this.shuffle && this.tracks.length > 1) {
      let nextIndex = this.index;
      while (nextIndex === this.index) {
        nextIndex = Math.floor(Math.random() * this.tracks.length);
      }
      this.index = nextIndex;
      await this.load(this.index, autoplay);
      return;
    }

    const last = this.index >= this.tracks.length - 1;
    if (last && !this.repeat) {
      await this.load(0, false);
      this.pause();
      this.audio.currentTime = 0;
      return;
    }

    this.index = last ? 0 : this.index + 1;
    await this.load(this.index, autoplay);
  }

  async prev() {
    if (!this.tracks.length) return;
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      this.onChange();
      return;
    }
    this.index = (this.index - 1 + this.tracks.length) % this.tracks.length;
    await this.load(this.index, !this.audio.paused);
  }

  seekRatio(ratio) {
    if (!Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = ratio * this.audio.duration;
  }

  syncMediaSession() {
    if (!("mediaSession" in navigator) || !this.current) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.current.title,
      artist: this.current.artist || "Stride",
      album: "Run playlist"
    });
    navigator.mediaSession.setActionHandler("play", () => this.play());
    navigator.mediaSession.setActionHandler("pause", () => this.pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => this.prev());
    navigator.mediaSession.setActionHandler("nexttrack", () => this.next(!this.audio.paused));
  }
}
