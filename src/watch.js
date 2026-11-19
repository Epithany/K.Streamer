let library = null;
let currentVideo = null;
let currentPlaylist = null;
let playlistOpen = true;
let sidebarOpen = false;

const $ = id => document.getElementById(id);
const q = sel => document.querySelector(sel);

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const params = new URLSearchParams(location.search);
  const id = params.get("v");

  if (!id) {
    location.href = "/";
    return;
  }

  const [libResponse, videoResponse] = await Promise.all([
    fetch("/api/library"),
    fetch(`/api/video/${encodeURIComponent(id)}`)
  ]);

  library = await libResponse.json();

  if (!videoResponse.ok) {
    $("videoTitle").textContent = "Video not found";
    return;
  }

  const payload = await videoResponse.json();
  currentVideo = payload.video;
  currentPlaylist = payload.playlist;

  bindChrome();
  bindPlayer();

  renderSidebar();
  renderVideo();
  renderRelated();
  renderPoster();

  if (currentPlaylist) {
    await renderPlaylist();
  }

  const video = $("video");
  video.src = currentVideo.streamUrl;
  video.load();

  connectLiveUpdates();
}

function connectLiveUpdates() {
  const source = new EventSource("/api/events");
  source.onmessage = event => {
    try {
      library = JSON.parse(event.data);
    } catch {
      return;
    }

    // Refresh whatever depends on the library, but never touch video.src -
    // a live update shouldn't interrupt playback.
    currentVideo = library.videos.find(v => v.id === currentVideo?.id) || currentVideo;
    currentPlaylist = currentVideo ? findPlaylistLocally(currentVideo) : currentPlaylist;

    renderSidebar();
    renderVideo();
    renderRelated();
    if (currentPlaylist) renderPlaylist();
  };
}

function findPlaylistLocally(video) {
  if (!video?.showId) return null;
  const show = library.shows.find(s => s.id === video.showId);
  const season = show?.seasons.find(s => s.id === video.seasonId);
  if (!show || !season) return null;

  return {
    id: season.id,
    name: `${show.name} · ${season.name}`,
    showId: show.id,
    seasonId: season.id,
    videoIds: season.videoIds
  };
}

// ---------- Site chrome: topbar, sidebar, search ----------

function bindChrome() {
  $("menuBtn").addEventListener("click", () => setSidebarOpen(!sidebarOpen));
  $("sidebarBackdrop")?.addEventListener("click", () => setSidebarOpen(false));

  $("searchBtn")?.addEventListener("click", goSearch);
  $("searchInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") goSearch();
  });

  $("playlistHeader").addEventListener("click", () => {
    playlistOpen = !playlistOpen;
    $("playlistItems").style.display = playlistOpen ? "block" : "none";
    $("playlistHeader").classList.toggle("open", playlistOpen);
  });
}

function setSidebarOpen(open) {
  sidebarOpen = open;
  $("sidebar").classList.toggle("open", open);
  $("sidebarBackdrop")?.classList.toggle("visible", open);
}

function goSearch() {
  const query = $("searchInput")?.value.trim() || "";
  location.href = query ? `/?q=${encodeURIComponent(query)}` : "/";
}

function renderSidebar() {
  const root = $("libraryTree");
  root.innerHTML = "";

  for (const show of library.shows) {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.innerHTML = `
      <button class="tree-toggle"><i class="fa-solid fa-chevron-right"></i></button>
      <i class="fa-solid fa-folder"></i>
      <span>${escapeHtml(show.name)}</span>
    `;

    const children = document.createElement("div");
    children.style.display = "none";

    const toggle = () => {
      const open = children.style.display !== "none";
      children.style.display = open ? "none" : "block";
      row.querySelector(".tree-toggle").classList.toggle("open", !open);
    };

    row.querySelector(".tree-toggle").addEventListener("click", e => {
      e.stopPropagation();
      toggle();
    });
    row.addEventListener("click", toggle);

    for (const season of show.seasons) {
      const srow = document.createElement("div");
      srow.className = "tree-row tree-indent";
      srow.innerHTML = `
        <button class="tree-toggle"><i class="fa-solid fa-chevron-right"></i></button>
        <i class="fa-regular fa-rectangle-list"></i>
        <span>${escapeHtml(season.name)}</span>
      `;

      const eps = document.createElement("div");
      eps.style.display = "none";

      const toggleSeason = () => {
        const open = eps.style.display !== "none";
        eps.style.display = open ? "none" : "block";
        srow.querySelector(".tree-toggle").classList.toggle("open", !open);
      };

      srow.querySelector(".tree-toggle").addEventListener("click", e => {
        e.stopPropagation();
        toggleSeason();
      });
      srow.addEventListener("click", toggleSeason);

      for (const id of season.videoIds) {
        const v = library.videos.find(x => x.id === id);
        if (!v) continue;

        const ep = document.createElement("a");
        ep.className = "tree-row tree-indent-2";
        ep.href = v.url;
        ep.innerHTML = `<i class="fa-solid fa-play"></i><span>${escapeHtml(v.name)}</span>`;
        eps.appendChild(ep);
      }

      children.appendChild(srow);
      children.appendChild(eps);
    }

    root.appendChild(row);
    root.appendChild(children);
  }

  for (const video of library.videos.filter(v => !v.showId)) {
    const row = document.createElement("a");
    row.className = "tree-row";
    row.href = video.url;
    row.innerHTML = `<i class="fa-regular fa-file-video"></i><span>${escapeHtml(video.name)}</span>`;
    root.appendChild(row);
  }
}

function renderVideo() {
  if (!currentVideo) return;

  $("videoTitle").textContent = currentVideo.name;

  const parts = [];
  if (currentVideo.showId) {
    const show = library.shows.find(s => s.id === currentVideo.showId);
    if (show) parts.push(show.name);
  }

  if (currentVideo.seasonNumber) parts.push(`Season ${currentVideo.seasonNumber}`);
  if (currentVideo.episodeNumber !== Infinity && Number.isFinite(currentVideo.episodeNumber)) {
    parts.push(`Episode ${String(currentVideo.episodeNumber).padStart(2, "0")}`);
  }

  $("videoMeta").textContent = parts.join(" · ") || "Standalone video";
  document.title = `${currentVideo.name} · Videos`;
}

function renderPoster() {
  const poster = $("posterImg");
  if (currentVideo?.thumbnail) {
    poster.src = currentVideo.thumbnail;
    poster.style.display = "";
  } else {
    poster.style.display = "none";
  }
}

async function renderPlaylist() {
  if (!currentPlaylist) return;

  $("playlistPanel").classList.remove("hidden");
  $("playlistTitle").textContent = currentPlaylist.name;
  $("playlistHeader").classList.toggle("open", playlistOpen);

  const items = $("playlistItems");
  items.innerHTML = "";

  currentPlaylist.videoIds.forEach((id, index) => {
    const v = library.videos.find(x => x.id === id);
    if (!v) return;

    const item = document.createElement("div");
    item.className = "playlist-item";
    if (v.id === currentVideo.id) item.classList.add("current");

    item.innerHTML = `
      <div class="playlist-num">${index + 1}</div>
      <div class="small-thumb">
        ${v.thumbnail ? `<img src="${v.thumbnail}" alt="">` : ""}
      </div>
      <div>
        <div class="item-title">${escapeHtml(v.name)}</div>
        <div class="item-sub">${episodeLabel(v)}</div>
      </div>
    `;

    item.addEventListener("click", () => {
      location.href = v.url;
    });

    items.appendChild(item);
  });
}

function renderRelated() {
  const list = $("relatedList");
  list.innerHTML = "";

  const candidates = library.videos
    .filter(v => v.id !== currentVideo?.id)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, {
      numeric: true,
      sensitivity: "base"
    }));

  for (const v of candidates) {
    const item = document.createElement("div");
    item.className = "related-item";

    item.innerHTML = `
      <div class="small-thumb">
        ${v.thumbnail ? `<img loading="lazy" src="${v.thumbnail}" alt="">` : ""}
      </div>
      <div>
        <div class="item-title">${escapeHtml(v.name)}</div>
        <div class="item-sub">${escapeHtml(v.relativePath)}</div>
      </div>
    `;

    item.addEventListener("click", () => {
      location.href = v.url;
    });

    list.appendChild(item);
  }
}

function navigatePlaylist(direction) {
  if (!currentPlaylist) {
    const index = library.videos.findIndex(v => v.id === currentVideo.id);
    const next = library.videos[index + direction];
    if (next) location.href = next.url;
    return;
  }

  const index = currentPlaylist.videoIds.indexOf(currentVideo.id);
  const nextId = currentPlaylist.videoIds[index + direction];

  if (nextId) {
    const next = library.videos.find(v => v.id === nextId);
    if (next) location.href = next.url;
  }
}

function episodeLabel(v) {
  const parts = [];

  if (v.seasonNumber) parts.push(`S${v.seasonNumber}`);
  if (Number.isFinite(v.episodeNumber)) {
    parts.push(`E${String(v.episodeNumber).padStart(2, "0")}`);
  }

  return parts.join(" · ") || "Video";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- Player (ported YouTube-clone controls, wired to our data) ----------

let hasStarted = false;
let isScrubbing = false;
let wasPaused;

function bindPlayer() {
  const videoContainer = $("videoContainer");
  const video = $("video");
  const timelineContainer = q(".timeline-container");
  const previewImg = q(".preview-img");
  const thumbnailImg = q(".thumbnail-img");
  const volumeSlider = q(".volume-slider");
  const muteBtn = q(".mute-btn");
  const playPauseBtn = q(".play-pause-btn");
  const captionsBtn = q(".captions-btn");
  const speedBtn = q(".speed-btn");
  const miniPlayerBtn = q(".mini-player-btn");
  const theaterBtn = q(".theater-btn");
  const fullScreenBtn = q(".full-screen-btn");
  const currentTimeElem = q(".current-time");
  const totalTimeElem = q(".total-time");
  const backBtn = q(".back-btn");
  const nextBtn = q(".next-btn");
  const skipBackBtn = q(".skip-back-btn");
  const skipForwardBtn = q(".skip-forward-btn");

  function previewUrl(n) {
    return `/thumbnails/previews/${currentVideo.id}-${String(n).padStart(2, "0")}.webp`;
  }

  // Timeline scrubbing, with real per-video preview frames once they've
  // been generated (falls back to nothing shown if previewCount is 0 -
  // e.g. a video that was just added and hasn't been processed yet).
  function handleTimelineUpdate(e) {
    const rect = timelineContainer.getBoundingClientRect();
    const percent = Math.min(Math.max(0, e.x - rect.x), rect.width) / rect.width;
    const count = currentVideo.previewCount || 0;

    timelineContainer.style.setProperty("--preview-position", percent);

    if (count > 0) {
      const n = Math.min(count, Math.max(1, Math.ceil(percent * count)));
      previewImg.src = previewUrl(n);
      if (isScrubbing) thumbnailImg.src = previewUrl(n);
    }

    if (isScrubbing) {
      e.preventDefault();
      timelineContainer.style.setProperty("--progress-position", percent);
    }
  }

  function toggleScrubbing(e) {
    const rect = timelineContainer.getBoundingClientRect();
    const percent = Math.min(Math.max(0, e.x - rect.x), rect.width) / rect.width;
    isScrubbing = (e.buttons & 1) === 1;
    videoContainer.classList.toggle("scrubbing", isScrubbing);

    if (isScrubbing) {
      wasPaused = video.paused;
      video.pause();
    } else {
      video.currentTime = percent * video.duration;
      if (!wasPaused) video.play();
    }

    handleTimelineUpdate(e);
  }

  timelineContainer.addEventListener("mousemove", handleTimelineUpdate);
  timelineContainer.addEventListener("mousedown", toggleScrubbing);
  document.addEventListener("mouseup", e => {
    if (isScrubbing) toggleScrubbing(e);
  });
  document.addEventListener("mousemove", e => {
    if (isScrubbing) handleTimelineUpdate(e);
  });

  // Playback speed
  speedBtn.addEventListener("click", () => {
    let rate = video.playbackRate + 0.25;
    if (rate > 2) rate = 0.25;
    video.playbackRate = rate;
    speedBtn.textContent = `${rate}x`;
  });

  // Captions - only wired up if a track actually loaded; we don't generate
  // subtitles server-side, so most videos simply won't have one and the
  // button hides itself rather than controlling nothing.
  video.addEventListener("loadedmetadata", () => {
    const track = video.textTracks[0];
    if (track) {
      track.mode = "hidden";
      captionsBtn.style.display = "";
      captionsBtn.addEventListener("click", () => {
        const isHidden = track.mode === "hidden";
        track.mode = isHidden ? "showing" : "hidden";
        videoContainer.classList.toggle("captions", isHidden);
      });
    } else {
      captionsBtn.style.display = "none";
    }
  }, { once: true });

  // Duration / progress
  video.addEventListener("loadeddata", () => {
    totalTimeElem.textContent = formatDuration(video.duration);
  });

  video.addEventListener("timeupdate", () => {
    currentTimeElem.textContent = formatDuration(video.currentTime);
    const percent = video.currentTime / video.duration;
    timelineContainer.style.setProperty("--progress-position", percent);
  });

  // Skip +/-10s (buttons and keyboard both call this)
  function skip(duration) {
    video.currentTime = Math.min(
      Math.max(0, video.currentTime + duration),
      video.duration || Infinity
    );
  }
  skipBackBtn.addEventListener("click", () => skip(-10));
  skipForwardBtn.addEventListener("click", () => skip(10));

  // Previous / next - our playlist, not the tutorial's
  backBtn.addEventListener("click", () => navigatePlaylist(-1));
  nextBtn.addEventListener("click", () => navigatePlaylist(1));

  // Volume
  muteBtn.addEventListener("click", () => { video.muted = !video.muted; });
  volumeSlider.addEventListener("input", e => {
    video.volume = e.target.value;
    video.muted = Number(e.target.value) === 0;
  });

  video.addEventListener("volumechange", () => {
    volumeSlider.value = video.volume;
    let level;
    if (video.muted || video.volume === 0) {
      volumeSlider.value = 0;
      level = "muted";
    } else if (video.volume >= 0.5) {
      level = "high";
    } else {
      level = "low";
    }
    videoContainer.dataset.volumeLevel = level;
  });

  // Theater / fullscreen / mini-player
  function toggleTheaterMode() {
    const on = videoContainer.classList.toggle("theater");
    document.body.classList.toggle("theater-mode", on);
  }
  theaterBtn.addEventListener("click", toggleTheaterMode);

  fullScreenBtn.addEventListener("click", async () => {
    if (document.fullscreenElement == null) {
      await videoContainer.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  });

  document.addEventListener("fullscreenchange", () => {
    videoContainer.classList.toggle("full-screen", Boolean(document.fullscreenElement));
  });

  miniPlayerBtn.addEventListener("click", () => {
    if (videoContainer.classList.contains("mini-player")) {
      document.exitPictureInPicture();
    } else {
      video.requestPictureInPicture();
    }
  });

  video.addEventListener("enterpictureinpicture", () => videoContainer.classList.add("mini-player"));
  video.addEventListener("leavepictureinpicture", () => videoContainer.classList.remove("mini-player"));

  // Play/pause + poster fade
  function togglePlay() {
    video.paused ? video.play().catch(() => {}) : video.pause();
  }

  playPauseBtn.addEventListener("click", togglePlay);
  video.addEventListener("click", togglePlay);

  video.addEventListener("play", () => {
    videoContainer.classList.remove("paused");
    if (!hasStarted) {
      hasStarted = true;
      videoContainer.classList.add("started"); // poster fades out for good
    }
  });

  video.addEventListener("pause", () => {
    videoContainer.classList.add("paused");
  });

  video.addEventListener("ended", () => navigatePlaylist(1));

  // Keyboard shortcuts
  document.addEventListener("keydown", e => {
    const tag = document.activeElement.tagName.toLowerCase();
    if (tag === "input") return;

    switch (e.key.toLowerCase()) {
      case " ":
        if (tag === "button") return;
      case "k":
        togglePlay();
        break;
      case "f":
        fullScreenBtn.click();
        break;
      case "t":
        toggleTheaterMode();
        break;
      case "i":
        miniPlayerBtn.click();
        break;
      case "m":
        video.muted = !video.muted;
        break;
      case "arrowleft":
      case "j":
        skip(-10);
        break;
      case "arrowright":
      case "l":
        skip(10);
        break;
      case "c":
        captionsBtn.click();
        break;
    }
  });
}

function formatDuration(time) {
  if (!Number.isFinite(time)) return "0:00";

  const seconds = Math.floor(time % 60);
  const minutes = Math.floor(time / 60) % 60;
  const hours = Math.floor(time / 3600);
  const pad = new Intl.NumberFormat(undefined, { minimumIntegerDigits: 2 });

  if (hours === 0) {
    return `${minutes}:${pad.format(seconds)}`;
  }
  return `${hours}:${pad.format(minutes)}:${pad.format(seconds)}`;
}
