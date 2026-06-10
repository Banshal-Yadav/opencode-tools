import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, ChildProcess, execSync, exec } from "child_process";
import * as net from "net";

// ─── Config ───────────────────────────────────────────────────────────────────

const BRAIN_DIR = path.join(os.homedir(), ".config", "opencode", "brain");
const MUSIC_DIR = path.join(BRAIN_DIR, "music");
const STATE_FILE = path.join(MUSIC_DIR, "state.json");
const LIBRARY_FILE = path.join(MUSIC_DIR, "library.json");
const FAVORITES_FILE = path.join(MUSIC_DIR, "favorites.json");
const PLAYLISTS_DIR = path.join(MUSIC_DIR, "playlists");
const DOWNLOADS_DIR = path.join(MUSIC_DIR, "downloads");
const CURRENT_M3U = path.join(MUSIC_DIR, "current.m3u");

const MPV_PIPE = process.platform === "win32"
    ? "\\\\.\\pipe\\mpv-pipe"
    : path.join(MUSIC_DIR, "mpv.sock");
const AUDIO_EXTS = new Set([".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus", ".wma", ".aac"]);

// Scoop install paths (fallback when PATH doesn't include them)
const SCOOP_DIR = process.env.SCOOP || path.join(os.homedir(), "scoop");
const SCOOP_SHIMS = path.join(SCOOP_DIR, "shims");
const SCOOP_APPS = path.join(SCOOP_DIR, "apps");

function findExe(name: string): string {
    // Check scoop shims first
    const shimPath = path.join(SCOOP_SHIMS, `${name}.exe`);
    if (fs.existsSync(shimPath)) return shimPath;
    // Check scoop apps directory
    const appDir = path.join(SCOOP_APPS, name, "current");
    const exePath = path.join(appDir, `${name}.exe`);
    if (fs.existsSync(exePath)) return exePath;
    // Try PATH lookup (Windows: where, others: which)
    try {
        const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
        const out = execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
        const first = out.split(/\r?\n/)[0];
        if (first) return first.trim();
    } catch { /* ignore */ }

    // Fallback to bare name (relies on PATH)
    return name;
}

const MPV_EXE = findExe("mpv");
const YTDLP_EXE = findExe("yt-dlp");
const FFPROBE_EXE = findExe("ffprobe");
const FFPLAY_EXE = findExe("ffplay");

let mpvProcess: ChildProcess | null = null;
let mpvPid: number | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureDirs(): void {
    ensureDir(MUSIC_DIR);
    ensureDir(PLAYLISTS_DIR);
    ensureDir(DOWNLOADS_DIR);
}

function readJSON(file: string, fallback: any = null): any {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { return fallback; }
}

function writeJSON(file: string, data: any): void {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function getState(): any {
    return readJSON(STATE_FILE, { current: null, queue: [], position: 0, volume: 50, playing: false, lastPositions: {} });
}

function saveState(state: any): void {
    writeJSON(STATE_FILE, state);
}

function getLibrary(): any[] {
    return readJSON(LIBRARY_FILE, []);
}

function saveLibrary(lib: any[]): void {
    writeJSON(LIBRARY_FILE, lib);
}

function getFavorites(): any[] {
    return readJSON(FAVORITES_FILE, []);
}

function saveFavorites(favs: any[]): void {
    writeJSON(FAVORITES_FILE, favs);
}

function isAudioFile(name: string): boolean {
    const ext = path.extname(name).toLowerCase();
    return AUDIO_EXTS.has(ext);
}

function sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*\x00-\x1f\uFFFD]/g, "").replace(/\s+/g, " ").trim();
}

function formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return "?:??";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTime(seconds: number): string {
    return formatDuration(seconds);
}

async function findAudioFiles(dir: string, maxDepth: number = 5): Promise<string[]> {
    const results: string[] = [];
    async function walk(current: string, depth: number): Promise<void> {
        if (depth > maxDepth) return;
        try {
            const entries = await fs.promises.readdir(current, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    await walk(full, depth + 1);
                } else if (entry.isFile() && isAudioFile(entry.name)) {
                    results.push(full);
                }
            }
        } catch { /* skip unreadable dirs */ }
    }
    if (fs.existsSync(dir)) await walk(dir, 0);
    return results;
}

function readMetadata(filePath: string): { title: string; artist: string; duration: number } {
    const basename = path.basename(filePath, path.extname(filePath));
    let title = basename;
    let artist = "Unknown";

    const cleanText = (t: string) => {
        return t
            .replace(/\s*[\(\[][^\]\)]*(lyric|video|cover|audio|official|lyrics|full song)[^\]\)]*[\)\]]/gi, "")
            .replace(/\s+/g, " ")
            .trim();
    };

    // Attempt to split artist and title by common delimiters
    const parts = basename.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
        artist = parts[0].trim();
        title = parts.slice(1).join(" - ").trim();
    }

    title = cleanText(title) || basename;
    artist = cleanText(artist) || "Unknown";

    // Try ffprobe first
    try {
        const cmd = `"${FFPROBE_EXE}" -v quiet -print_format json -show_format "${filePath}"`;
        const out = execSync(cmd, { encoding: "utf8", timeout: 5000 });
        const data = JSON.parse(out);
        const fmt = data?.format || {};
        const tagTitle = fmt?.tags?.title ? cleanText(fmt.tags.title) : "";
        const tagArtist = fmt?.tags?.artist ? cleanText(fmt.tags.artist) : "";

        if (tagTitle) title = tagTitle;
        if (tagArtist && tagArtist.toLowerCase() !== "unknown") artist = tagArtist;

        const duration = parseFloat(fmt?.duration || "0");
        return { title, artist, duration };
    } catch {
        return { title, artist, duration: 0 };
    }
}

function getFfmpegLocationArg(): string | null {
    try {
        if (fs.existsSync(FFPROBE_EXE)) {
            const dir = path.dirname(FFPROBE_EXE);
            if (dir && dir !== ".") return dir;
        }
    } catch { /* ignore */ }
    return null;
}

function execCommand(command: string, options: any): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                const msg = (stderr || "").toString().trim() || error.message;
                reject(new Error(msg));
                return;
            }
            resolve((stdout || "").toString());
        });
    });
}

// ─── mpv Control ──────────────────────────────────────────────────────────────

function stopMpv(): void {
    if (mpvProcess) {
        try { mpvProcess.kill("SIGTERM"); } catch { /* ignore */ }
        mpvProcess = null;
    }
    if (mpvPid !== null) {
        try {
            execSync(`taskkill /F /PID ${mpvPid} /T 2>nul`, { timeout: 2000 });
        } catch { /* ignore */ }
        mpvPid = null;
    }
}

async function sendMpvCommand(command: any): Promise<string> {
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const result = await new Promise<string | null>((resolve) => {
            try {
                const client = net.createConnection(MPV_PIPE, () => {
                    client.write(JSON.stringify({ command }) + "\n");
                });
                let data = "";
                client.on("data", (chunk) => { data += chunk.toString(); });
                client.on("end", () => resolve(data.trim()));
                client.on("error", () => resolve(null));
                client.setTimeout(1000, () => { client.destroy(); resolve(null); });
            } catch {
                resolve(null);
            }
        });
        if (result !== null) return result;
        if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    return "";
}

async function getMpvProperty(prop: string): Promise<string> {
    const raw = await sendMpvCommand(["get_property", prop]);
    if (!raw) return "";
    try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.data !== undefined) {
            return String(parsed.data);
        }
    } catch { /* ignore */ }
    return "";
}

async function capturePlaybackPosition(state: any): Promise<void> {
    try {
        const pathValue = await getMpvProperty("path");
        const posStr = await getMpvProperty("time-pos");
        const pos = parseFloat(posStr);
        if (!isNaN(pos) && pos >= 0) {
            state.position = pos;
            if (pathValue) {
                if (!state.lastPositions) state.lastPositions = {};
                state.lastPositions[pathValue] = pos;
                const lib = getLibrary();
                const match = lib.find((s: any) => s.path === pathValue);
                if (match) state.current = match;
            }
        }
    } catch { /* ignore */ }
}

function startMpv(playlistPath: string, volume: number, startSeconds?: number): void {
    stopMpv();

    if (process.platform !== "win32") {
        try {
            if (fs.existsSync(MPV_PIPE)) fs.unlinkSync(MPV_PIPE);
        } catch { /* ignore */ }
    }

    const args = [
        "--no-video",
        `--volume=${volume}`,
        `--input-ipc-server=${MPV_PIPE}`,
        `--playlist=${playlistPath}`,
        startSeconds !== undefined && startSeconds > 0 ? `--start=${Math.floor(startSeconds)}` : "",
        "--keep-open=no",
        "--term-status-msg=",
        "--really-quiet",
    ].filter(Boolean);

    mpvProcess = spawn(MPV_EXE, args, {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
    });

    mpvPid = mpvProcess.pid || null;

    mpvProcess.on("exit", () => {
        mpvProcess = null;
        mpvPid = null;
        const state = getState();
        state.playing = false;
        saveState(state);
    });

    mpvProcess.on("error", () => {
        mpvProcess = null;
        mpvPid = null;
    });
}

// ─── M3U Playlist ─────────────────────────────────────────────────────────────

function buildM3U(files: string[], outputPath: string): void {
    const lines = files.map((f) => `#EXTINF:0,${path.basename(f, path.extname(f))}\n${f}`);
    fs.writeFileSync(outputPath, "#EXTM3U\n" + lines.join("\n"), "utf8");
}

// ─── Library Scanning ─────────────────────────────────────────────────────────

async function scanDirectory(dir: string): Promise<{ added: number; songs: any[] }> {
    const files = await findAudioFiles(dir);
    const existing = getLibrary();
    const existingPaths = new Set(existing.map((s: any) => s.path));
    let added = 0;

    for (const file of files) {
        if (existingPaths.has(file)) continue;
        const meta = readMetadata(file);
        existing.push({
            path: file,
            title: meta.title,
            artist: meta.artist,
            duration: meta.duration,
            addedAt: new Date().toISOString(),
        });
        added++;
    }

    // Remove files that no longer exist
    const cleaned = existing.filter((s: any) => fs.existsSync(s.path));
    saveLibrary(cleaned);
    return { added, songs: cleaned };
}

// ─── Search ───────────────────────────────────────────────────────────────────

function searchLibrary(query: string, lib?: any[]): any[] {
    if (!lib) lib = getLibrary();
    const q = query.toLowerCase();
    return lib.filter(
        (s: any) =>
            s.title.toLowerCase().includes(q) ||
            s.artist.toLowerCase().includes(q) ||
            s.path.toLowerCase().includes(q)
    );
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export default tool({
    description:
        "Terminal music player with mpv backend. Play local audio files, manage playlists & favorites, download from YouTube via yt-dlp, and control playback (pause/next/volume) from chat. Stores state in brain/music/.",
    args: {
        action: tool.schema
            .enum([
                "scan", "library", "play", "pause", "stop", "next", "prev",
                "volume", "status", "download", "playlist", "favorite",
                "shuffle", "check", "metadata", "queue", "remove",
            ])
            .default("status")
            .describe("Action to perform."),
        query: tool.schema
            .string()
            .optional()
            .describe("Search term, song name, or playlist name."),
        path: tool.schema
            .string()
            .optional()
            .describe("Directory path to scan or file path to play."),
        url: tool.schema
            .string()
            .optional()
            .describe("YouTube URL to download audio from."),
        name: tool.schema
            .string()
            .optional()
            .describe("Playlist name for create/play actions."),
        value: tool.schema
            .number()
            .optional()
            .describe("Volume level 0-100."),
        title: tool.schema
            .string()
            .optional()
            .describe("New title for metadata action."),
        artist: tool.schema
            .string()
            .optional()
            .describe("New artist for metadata action."),
    },

    async execute(args) {
        ensureDirs();

        // ── CHECK ────────────────────────────────────────────────────────────
        if (args.action === "check") {
            const checks: string[] = [];

            try {
                execSync(`"${MPV_EXE}" --version`, { timeout: 3000, stdio: "pipe" });
                checks.push("✅ mpv — installed");
            } catch {
                checks.push("❌ mpv — NOT installed (needed for playback)");
            }

            try {
                execSync(`"${YTDLP_EXE}" --version`, { timeout: 3000, stdio: "pipe" });
                checks.push("✅ yt-dlp — installed");
            } catch {
                checks.push("❌ yt-dlp — NOT installed (needed for downloads)");
            }

            try {
                execSync(`"${FFPROBE_EXE}" -version`, { timeout: 3000, stdio: "pipe" });
                checks.push("✅ ffprobe — installed");
            } catch {
                checks.push("ℹ️ ffprobe not found — using filenames instead of metadata");
            }

            const lib = getLibrary();
            checks.push(`📚 Library: ${lib.length} songs`);

            const favs = getFavorites();
            checks.push(`❤️ Favorites: ${favs.length} songs`);

            const playlists = fs.readdirSync(PLAYLISTS_DIR).filter(f => f.endsWith(".json"));
            checks.push(`📋 Playlists: ${playlists.length}`);

            return checks.join("\n");
        }

        // ── SCAN ──────────────────────────────────────────────────────────────
        if (args.action === "scan") {
            const scanPath = args.path || DOWNLOADS_DIR;
            if (!fs.existsSync(scanPath)) {
                return `Error: path '${scanPath}' does not exist.`;
            }
            const result = await scanDirectory(scanPath);
            return `Scanned ${scanPath}\nAdded ${result.added} new songs\nLibrary now has ${result.songs.length} songs`;
        }

        // ── LIBRARY ───────────────────────────────────────────────────────────
        if (args.action === "library") {
            const lib = args.query ? searchLibrary(args.query) : getLibrary();
            if (lib.length === 0) {
                return args.query
                    ? `No songs found matching '${args.query}'.`
                    : "Library is empty. Use `scan` to add music or `download` to grab from YouTube.";
            }

            const favorites = new Set(getFavorites().map((f: any) => f.path));

            let output = args.query
                ? `### 🔍 Search Results for '${args.query}' (${lib.length} songs):\n\n`
                : `### 📚 Library (${lib.length} songs):\n\n`;

            output += `| # | Title | Artist | Duration | Source | Fav |\n`;
            output += `|---|-------|--------|----------|--------|-----|\n`;

            lib.slice(0, 50).forEach((s: any, i: number) => {
                const fav = favorites.has(s.path) ? "❤️" : "";
                const dur = formatDuration(s.duration);
                const source = s.path?.includes("downloads") ? "📥 YouTube" : "💻 Local";
                output += `| ${i + 1} | **${s.title}** | ${s.artist} | ${dur} | ${source} | ${fav} |\n`;
            });

            if (lib.length > 50) {
                output += `\n...and ${lib.length - 50} more. Use a search query to narrow.`;
            }

            return output;
        }

        // ── PLAY ──────────────────────────────────────────────────────────────
        if (args.action === "play") {
            const state = getState();
            let songs: any[] = [];
            const resumePosition = !args.name && !args.query && !args.path && state.current && state.playing === false
                ? (state.lastPositions?.[state.current.path] ?? state.position)
                : 0;

            // Play by playlist name
            if (args.name) {
                const plFile = path.join(PLAYLISTS_DIR, `${args.name}.json`);
                if (!fs.existsSync(plFile)) {
                    return `Error: playlist '${args.name}' not found.`;
                }
                const pl = readJSON(plFile, []);
                songs = pl;
                if (songs.length === 0) return `Playlist '${args.name}' is empty.`;
            }
            // Play by search query
            else if (args.query) {
                songs = searchLibrary(args.query);
                if (songs.length === 0) {
                    // Auto-download: search YouTube and grab the first result
                    try {
                        const ffmpegDir = getFfmpegLocationArg();
                        const ytSearch = await execCommand(
                            `"${YTDLP_EXE}" --flat-playlist --dump-single-json ytsearch:"${args.query}"`,
                            { timeout: 15000, encoding: "utf8", shell: true }
                        );
                        const searchResult = JSON.parse(ytSearch);
                        const firstUrl = searchResult?.entries?.[0]?.url || searchResult?.url || searchResult?.webpage_url;
                        if (firstUrl) {
                            const output = path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s");
                            const dlArgs = [
                                `"${YTDLP_EXE}"`,
                                "--extract-audio",
                                "--audio-format mp3",
                                "--js-runtimes node",
                                ffmpegDir ? `--ffmpeg-location "${ffmpegDir}"` : "",
                                `--output "${output}"`,
                                `"${firstUrl}"`,
                            ].filter(Boolean).join(" ");
                            await execCommand(dlArgs, { timeout: 120000, encoding: "utf8", shell: true });
                            const scanResult = await scanDirectory(DOWNLOADS_DIR);
                            songs = searchLibrary(args.query);
                            if (songs.length > 0) {
                                const msg = `⬇️ Auto-downloaded from YouTube. Playing now.`;
                                // fall through to play
                            }
                        }
                    } catch { /* auto-download failed, fall through to error */ }

                    if (songs.length === 0) {
                        return `No songs found for '${args.query}'. Try \`download [url]\` to grab it from YouTube.`;
                    }
                }
            }
            // Play all or specific path
            else if (args.path) {
                const fullPath = path.resolve(args.path);
                if (!fs.existsSync(fullPath)) return `Error: file '${fullPath}' not found.`;
                songs = [{ path: fullPath, title: path.basename(fullPath, path.extname(fullPath)), artist: "Unknown", duration: 0 }];
            }
            // No args — resume or play all
            else {
                if (state.current && state.playing === false) {
                    // Resume last song
                    songs = [state.current];
                } else {
                    songs = getLibrary();
                    if (songs.length === 0) return "Library is empty. Add music first — `scan` or `download`.";
                }
            }

            // Verify file existence before playing
            const missingCount = songs.length - songs.filter(s => fs.existsSync(s.path)).length;
            songs = songs.filter(s => fs.existsSync(s.path));

            if (songs.length === 0) {
                return missingCount > 0
                    ? `Error: The requested song file(s) could not be found on disk.`
                    : "Nothing to play.";
            }

            const filePaths = songs.map((s: any) => s.path);
            buildM3U(filePaths, CURRENT_M3U);

            state.queue = filePaths;
            state.position = 0;
            state.current = songs[0];
            state.playing = true;
            state.volume = state.volume || 50;
            saveState(state);

            startMpv(CURRENT_M3U, state.volume, resumePosition || undefined);

            if (resumePosition && resumePosition > 0) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                await sendMpvCommand(["set_property", "time-pos", resumePosition]);
                state.position = resumePosition;
                saveState(state);
            }

            const first = songs[0];
            const dur = formatDuration(first.duration);
            const total = songs.length;

            return total === 1
                ? `▶️ Playing: ${first.title} — ${first.artist} [${dur}]`
                : `▶️ Playing playlist (${total} songs). Now: ${first.title} — ${first.artist} [${dur}]`;
        }

        // ── PAUSE / RESUME ────────────────────────────────────────────────────
        if (args.action === "pause") {
            const state = getState();
            if (!state.playing) {
                // Resume
                await sendMpvCommand(["set_property", "pause", false]);
                state.playing = true;
                saveState(state);
                const current = state.current;
                return current
                    ? `▶️ Resumed: ${current.title} — ${current.artist}`
                    : "▶️ Resumed";
            } else {
                await capturePlaybackPosition(state);
                await sendMpvCommand(["set_property", "pause", true]);
                state.playing = false;
                saveState(state);
                const current = state.current;
                return current
                    ? `⏸️ Paused: ${current.title} — ${current.artist}`
                    : "⏸️ Paused";
            }
        }

        // ── STOP ──────────────────────────────────────────────────────────────
        if (args.action === "stop") {
            const state = getState();
            await capturePlaybackPosition(state);
            stopMpv();
            state.playing = false;
            saveState(state);
            return "⏹️ Stopped.";
        }

        // ── NEXT ──────────────────────────────────────────────────────────────
        if (args.action === "next") {
            await sendMpvCommand(["playlist-next"]);
            const state = getState();
            // Update state after a brief delay to let mpv switch tracks
            await new Promise(r => setTimeout(r, 500));
            return "⏭️ Skipped to next track.";
        }

        // ── PREV ──────────────────────────────────────────────────────────────
        if (args.action === "prev") {
            await sendMpvCommand(["playlist-prev"]);
            await new Promise(r => setTimeout(r, 500));
            return "⏮️ Went to previous track.";
        }

        // ── VOLUME ────────────────────────────────────────────────────────────
        if (args.action === "volume") {
            const vol = args.value !== undefined ? args.value : 50;
            const clamped = Math.max(0, Math.min(100, vol));
            await sendMpvCommand(["set_property", "volume", clamped]);
            const state = getState();
            state.volume = clamped;
            saveState(state);
            return `🔊 Volume set to ${clamped}%`;
        }

        // ── STATUS ────────────────────────────────────────────────────────────
        if (args.action === "status") {
            const state = getState();

            if (state.playing) {
                await capturePlaybackPosition(state);
                saveState(state);
            }

            if (!state.current || !state.playing) {
                const lib = getLibrary();
                return [
                    "⏹️ No music playing.",
                    `📚 Library: ${lib.length} songs`,
                    `💡 Try: \`play "song name"\` or \`download [url]\``,
                ].join("\n");
            }

            // Try to get current time from mpv
            let timePos = "";
            let progressBar = "";
            try {
                const posStr = await getMpvProperty("time-pos");
                const durStr = await getMpvProperty("duration");
                if (posStr && durStr) {
                    const pos = parseFloat(posStr);
                    const dur = parseFloat(durStr);
                    if (!isNaN(pos) && !isNaN(dur) && dur > 0) {
                        const percent = Math.round((pos / dur) * 100);
                        const barLength = 20;
                        const filledLength = Math.round(barLength * (pos / dur));
                        const filled = "█".repeat(Math.max(0, Math.min(barLength, filledLength)));
                        const empty = "░".repeat(Math.max(0, Math.min(barLength, barLength - filledLength)));
                        progressBar = `\n   [${filled}${empty}] ${percent}%`;
                        timePos = `${formatTime(pos)} / ${formatTime(dur)}`;
                    }
                }
            } catch { /* ignore */ }

            const current = state.current;
            const dur = formatDuration(current.duration);
            const prog = timePos || dur;

            return [
                `▶️ Now Playing:`,
                `   ${current.title} — ${current.artist}`,
                `   ${prog} | 🔊 ${state.volume}%${progressBar}`,
                ``,
                `Commands: pause | stop | next | prev | volume [0-100]`,
            ].join("\n");
        }

        // ── DOWNLOAD ──────────────────────────────────────────────────────────
        if (args.action === "download") {
            if (!args.url) return "Error: url is required for download.";

            const isPlaylist = args.url.includes("list=");
            const outputTemplate = isPlaylist
                ? path.join(DOWNLOADS_DIR, "%(playlist_index)s - %(title)s.%(ext)s")
                : path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s");

            try {
                const ffmpegDir = getFfmpegLocationArg();
                const dlArgs = [
                    `"${YTDLP_EXE}"`,
                    "--extract-audio",
                    "--audio-format mp3",
                    "--yes-playlist",
                    "--embed-thumbnail",
                    "--restrict-filenames",
                    "--windows-filenames",
                    "--no-overwrites",
                    "--js-runtimes node",
                    ffmpegDir ? `--ffmpeg-location "${ffmpegDir}"` : "",
                    `--output "${outputTemplate}"`,
                    `"${args.url}"`,
                ].filter(Boolean).join(" ");

                const result = await execCommand(
                    dlArgs,
                    { timeout: 600000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: true }
                );

                // Scan downloads dir to add new songs to library
                const beforeCount = getLibrary().length;
                await scanDirectory(DOWNLOADS_DIR);
                const afterCount = getLibrary().length;
                const newSongs = afterCount - beforeCount;

                // Extract downloaded filenames from yt-dlp output
                const matches = [...result.matchAll(/\[ExtractAudio\] Destination:\s*(.+\.mp3)/gi)];
                const names = matches.map((m) => path.basename(m[1]));

                const lines = [`✅ Downloaded ${newSongs} new song(s)`];
                if (names.length <= 5) {
                    names.forEach((n) => lines.push(`   • ${n}`));
                } else {
                    lines.push(`   • ${names[0]}`);
                    lines.push(`   • ${names[1]}`);
                    lines.push(`   • ...and ${names.length - 2} more`);
                }
                lines.push(`📚 Library now has ${afterCount} songs`);
                return lines.join("\n");

            } catch (err: any) {
                return `Error downloading: ${err.message || "unknown error"}`;
            }
        }

        // ── PLAYLIST ──────────────────────────────────────────────────────────
        if (args.action === "playlist") {
            const subAction = args.query || "list";

            // play "playlist name"
            if (subAction.startsWith("play ") || subAction === "play") {
                const plName = subAction.replace(/^play\s*/i, "").trim();
                if (!plName) {
                    const pls = fs.readdirSync(PLAYLISTS_DIR).filter(f => f.endsWith(".json")).map(f => path.basename(f, ".json"));
                    return pls.length === 0
                        ? "No playlists yet. Use `playlist create [name]` to make one."
                        : `Playlists:\n${pls.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\nUse \`playlist play [name]\` to play one.`;
                }
                const plFile = path.join(PLAYLISTS_DIR, `${plName}.json`);
                if (!fs.existsSync(plFile)) return `Playlist '${plName}' not found.`;
                const songs = readJSON(plFile, []);
                if (songs.length === 0) return `Playlist '${plName}' is empty.`;

                const filePaths = songs.map((s: any) => s.path);
                buildM3U(filePaths, CURRENT_M3U);

                const state = getState();
                state.queue = filePaths;
                state.position = 0;
                state.current = songs[0];
                state.playing = true;
                saveState(state);

                startMpv(CURRENT_M3U, state.volume);
                return `▶️ Playing playlist '${plName}' (${songs.length} songs). Now: ${songs[0].title}`;
            }

            // create / save [name]
            if (subAction.startsWith("create ") || subAction.startsWith("save ")) {
                const plName = subAction.replace(/^(create|save)\s*/i, "").trim();
                if (!plName) return "Error: provide a playlist name. Usage: `playlist create my-list`";
                const state = getState();
                const songs = state.queue && state.queue.length > 0
                    ? state.queue.map((p: string) => {
                        const lib = getLibrary();
                        return lib.find((s: any) => s.path === p) || { path: p, title: path.basename(p, path.extname(p)), artist: "Unknown", duration: 0 };
                    })
                    : getLibrary();

                if (songs.length === 0) return "No songs to save. Add music first.";
                writeJSON(path.join(PLAYLISTS_DIR, `${plName}.json`), songs);
                return `✅ Playlist '${plName}' created with ${songs.length} songs.`;
            }

            // list
            if (subAction === "list") {
                const pls = fs.readdirSync(PLAYLISTS_DIR).filter(f => f.endsWith(".json")).map(f => {
                    const songs = readJSON(path.join(PLAYLISTS_DIR, f), []);
                    return `${path.basename(f, ".json")} (${songs.length} songs)`;
                });
                return pls.length === 0
                    ? "No playlists yet."
                    : `Playlists:\n${pls.join("\n")}`;
            }

            // delete [name]
            if (subAction.startsWith("delete ")) {
                const plName = subAction.replace(/^delete\s*/i, "").trim();
                const plFile = path.join(PLAYLISTS_DIR, `${plName}.json`);
                if (!fs.existsSync(plFile)) return `Playlist '${plName}' not found.`;
                fs.unlinkSync(plFile);
                return `🗑️ Deleted playlist '${plName}'.`;
            }

            // If just a name, play it
            const plFile = path.join(PLAYLISTS_DIR, `${subAction}.json`);
            if (fs.existsSync(plFile)) {
                const songs = readJSON(plFile, []);
                if (songs.length === 0) return `Playlist '${subAction}' is empty.`;
                const filePaths = songs.map((s: any) => s.path);
                buildM3U(filePaths, CURRENT_M3U);
                const state = getState();
                state.queue = filePaths;
                state.position = 0;
                state.current = songs[0];
                state.playing = true;
                saveState(state);
                startMpv(CURRENT_M3U, state.volume);
                return `▶️ Playing playlist '${subAction}' (${songs.length} songs).`;
            }

            return `Unknown playlist command. Try: list, create [name], play [name], delete [name]`;
        }

        // ── FAVORITE ──────────────────────────────────────────────────────────
        if (args.action === "favorite") {
            const favs = getFavorites();

            // List favorites
            if (args.query === "list") {
                if (favs.length === 0) return "💔 No favorites yet. Use `favorite` while a song plays or `favorite \"song name\"`.";
                const lines = favs.map((s: any, i: number) => {
                    const dur = formatDuration(s.duration);
                    return `  ${i + 1}. ${s.title}\n     Artist: ${s.artist}  |  ${dur}`;
                });
                return `❤️ **Favorites (${favs.length} songs)**\n${lines.join("\n\n")}`;
            }

            let song: any = null;

            if (args.query) {
                const results = searchLibrary(args.query);
                if (results.length === 0) return `No songs found for '${args.query}'.`;
                song = results[0];
            } else {
                const state = getState();
                if (!state.current) return "No song currently playing. Specify a song name.";
                song = state.current;
            }

            const alreadyFav = favs.some((f: any) => f.path === song.path);

            if (alreadyFav) {
                const filtered = favs.filter((f: any) => f.path !== song.path);
                saveFavorites(filtered);
                return `💔 Removed from favorites: ${song.title} — ${song.artist}`;
            } else {
                favs.push(song);
                saveFavorites(favs);
                return `❤️ Added to favorites: ${song.title} — ${song.artist}`;
            }
        }

        // ── SHUFFLE ───────────────────────────────────────────────────────────
        if (args.action === "shuffle") {
            let pool: any[] = [];

            if (args.query === "favorites" || args.query === "favs") {
                pool = getFavorites();
                if (pool.length === 0) return "💔 No favorites to shuffle. Add some favorites first.";
            } else if (args.query) {
                const plFile = path.join(PLAYLISTS_DIR, `${args.query}.json`);
                if (fs.existsSync(plFile)) {
                    pool = readJSON(plFile, []);
                    if (pool.length === 0) return `Playlist '${args.query}' is empty.`;
                } else {
                    pool = searchLibrary(args.query);
                    if (pool.length === 0) return `No songs found for '${args.query}'.`;
                }
            } else {
                pool = getLibrary();
                if (pool.length === 0) return "Library is empty.";
            }

            const shuffled = [...pool].sort(() => Math.random() - 0.5);
            const filePaths = shuffled.map((s: any) => s.path);
            buildM3U(filePaths, CURRENT_M3U);

            const state = getState();
            state.queue = filePaths;
            state.position = 0;
            state.current = shuffled[0];
            state.playing = true;
            saveState(state);

            startMpv(CURRENT_M3U, state.volume);
            return `🔀 Shuffling ${shuffled.length} songs. Now: ${shuffled[0].title} — ${shuffled[0].artist}`;
        }

        // ── QUEUE ──────────────────────────────────────────────────────────────
        if (args.action === "queue") {
            // ── Add to queue ──
            if (args.query) {
                const lib = getLibrary();
                const results = searchLibrary(args.query, lib);
                if (results.length === 0) return `No songs found for '${args.query}'.`;

                const state = getState();
                if (!state.queue) state.queue = [];

                for (const song of results) {
                    state.queue.push(song.path);
                    // Append to mpv's running playlist if playing
                    if (state.playing) {
                        await sendMpvCommand(["loadfile", song.path, "append"]);
                    }
                }

                // If nothing playing, start from the first queued song
                if (!state.playing) {
                    const firstInLib = lib.find((s: any) => s.path === state.queue[0]);
                    state.current = firstInLib || results[0];
                    state.playing = true;
                    state.position = 0;
                    saveState(state);
                    buildM3U(state.queue, CURRENT_M3U);
                    startMpv(CURRENT_M3U, state.volume || 50);
                } else {
                    saveState(state);
                }

                const first = results[0];
                const dur = formatDuration(first.duration);
                return results.length === 1
                    ? `➕ Queued: ${first.title} — ${first.artist} [${dur}]`
                    : `➕ Queued ${results.length} songs:\n   ${results.map((s: any) => `${s.title} — ${s.artist}`).join("\n   ")}`;
            }

            // ── Show queue ──
            const state = getState();
            if (!state.queue || state.queue.length === 0) return "Queue is empty. Play something first.";

            const lib = getLibrary();
            const lines = state.queue.map((p: string, i: number) => {
                const song = lib.find((s: any) => s.path === p);
                const nowPlaying = i === 0 && state.playing ? "▶️ " : "   ";
                if (song) {
                    return `${nowPlaying}${i + 1}. ${song.title} — ${song.artist} [${formatDuration(song.duration)}]`;
                }
                return `${nowPlaying}${i + 1}. ${path.basename(p, path.extname(p))}`;
            });

            const header = state.playing
                ? `📋 Queue (${state.queue.length} songs) — currently playing #1\n`
                : `📋 Queue (${state.queue.length} songs)\n`;
            return header + lines.join("\n");
        }

        // ── METADATA ───────────────────────────────────────────────────────────
        if (args.action === "metadata") {
            if (!args.query) return "Error: specify a song to edit. Usage: `metadata \"song name\" title=\"New Title\" artist=\"New Artist\"`";
            if (!args.title && !args.artist) return "Error: provide at least `title` or `artist` to update.";

            const lib = getLibrary();
            const results = searchLibrary(args.query, lib);
            if (results.length === 0) return `No songs found for '${args.query}'.`;

            const song = results[0];
            const changes: string[] = [];
            if (args.title) { song.title = args.title; changes.push(`title → "${args.title}"`); }
            if (args.artist) { song.artist = args.artist; changes.push(`artist → "${args.artist}"`); }

            saveLibrary(lib);

            // Also update favorites if present
            const favs = getFavorites();
            const favIdx = favs.findIndex((f: any) => f.path === song.path);
            if (favIdx >= 0) {
                if (args.title) favs[favIdx].title = args.title;
                if (args.artist) favs[favIdx].artist = args.artist;
                saveFavorites(favs);
            }

            return `✅ Updated metadata for "${song.title}":\n   ${changes.join("\n   ")}`;
        }

        // ── REMOVE ─────────────────────────────────────────────────────────────
        if (args.action === "remove") {
            if (!args.query) return "Error: specify a song to remove. Usage: `remove \"song name\"`.";

            const lib = getLibrary();
            const results = searchLibrary(args.query, lib);
            if (results.length === 0) return `No songs found for '${args.query}'.`;

            const song = results[0];
            const wasFavorite = getFavorites().some((f: any) => f.path === song.path);

            // Delete file
            let fileDeleted = false;
            try {
                if (fs.existsSync(song.path)) {
                    fs.unlinkSync(song.path);
                    fileDeleted = true;
                }
            } catch { /* file may be in use */ }

            // Remove from library
            const filtered = lib.filter((s: any) => s.path !== song.path);
            saveLibrary(filtered);

            // Remove from favorites
            if (wasFavorite) {
                const favs = getFavorites().filter((f: any) => f.path !== song.path);
                saveFavorites(favs);
            }

            const lines = [
                `🗑️ Removed: ${song.title} — ${song.artist}`,
                fileDeleted ? "   🗑️ File deleted" : "   ⚠️ File not found (library entry removed)",
                wasFavorite ? "   💔 Removed from favorites" : "",
                `📚 Library now has ${filtered.length} songs`,
            ].filter(Boolean);

            return lines.join("\n");
        }

        return `Unknown action '${args.action}'. Available: scan, library, play, pause, stop, next, prev, volume, status, download, playlist, favorite, shuffle, check, metadata, queue, remove`;
    },
});
