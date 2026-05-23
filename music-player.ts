import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, ChildProcess, execSync } from "child_process";
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

const MPV_PIPE = "\\\\.\\pipe\\mpv-pipe";
const AUDIO_EXTS = new Set([".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus", ".wma", ".aac"]);

// Scoop install paths (fallback when PATH doesn't include them)
const SCOOP_DIR = path.join(os.homedir(), "scoop");
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
    // Fallback to bare name (relies on PATH)
    return name;
}

const MPV_EXE = findExe("mpv");
const YTDLP_EXE = findExe("yt-dlp");
const FFPROBE_EXE = findExe("ffprobe");
const FFPLAY_EXE = findExe("ffplay");

let mpvProcess: ChildProcess | null = null;

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
    return readJSON(STATE_FILE, { current: null, queue: [], position: 0, volume: 50, playing: false });
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

function formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return "?:??";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTime(seconds: number): string {
    return formatDuration(seconds);
}

function findAudioFiles(dir: string, maxDepth: number = 5): string[] {
    const results: string[] = [];
    function walk(current: string, depth: number): void {
        if (depth > maxDepth) return;
        try {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    walk(full, depth + 1);
                } else if (entry.isFile() && isAudioFile(entry.name)) {
                    results.push(full);
                }
            }
        } catch { /* skip unreadable dirs */ }
    }
    if (fs.existsSync(dir)) walk(dir, 0);
    return results;
}

function readMetadata(filePath: string): { title: string; artist: string; duration: number } {
    const name = path.basename(filePath, path.extname(filePath));
    // Try ffprobe first
    try {
        const cmd = `"${FFPROBE_EXE}" -v quiet -print_format json -show_format "${filePath}"`;
        const out = execSync(cmd, { encoding: "utf8", timeout: 5000 });
        const data = JSON.parse(out);
        const fmt = data?.format || {};
        const title = fmt?.tags?.title || name;
        const artist = fmt?.tags?.artist || "Unknown";
        const duration = parseFloat(fmt?.duration || "0");
        return { title, artist, duration };
    } catch {
        return { title: name, artist: "Unknown", duration: 0 };
    }
}

// ─── mpv Control ──────────────────────────────────────────────────────────────

function stopMpv(): void {
    if (mpvProcess) {
        try { mpvProcess.kill("SIGTERM"); } catch { /* ignore */ }
        mpvProcess = null;
    }
    // Also kill any lingering mpv instances we spawned
    try {
        execSync("taskkill /F /IM mpv.exe /T 2>nul", { timeout: 2000 });
    } catch { /* none running */ }
}

async function sendMpvCommand(command: any): Promise<string> {
    return new Promise((resolve) => {
        try {
            const client = net.createConnection(MPV_PIPE, () => {
                client.write(JSON.stringify({ command }) + "\n");
            });
            let data = "";
            client.on("data", (chunk) => { data += chunk.toString(); });
            client.on("end", () => resolve(data.trim()));
            client.on("error", () => resolve(""));
            client.setTimeout(3000, () => { client.destroy(); resolve(""); });
        } catch {
            resolve("");
        }
    });
}

async function getMpvProperty(prop: string): Promise<string> {
    return sendMpvCommand(["get_property", prop]);
}

function startMpv(playlistPath: string, volume: number): void {
    stopMpv();

    const args = [
        "--no-video",
        `--volume=${volume}`,
        `--input-ipc-server=${MPV_PIPE}`,
        `--playlist=${playlistPath}`,
        "--keep-open=no",
        "--term-status-msg=",
        "--really-quiet",
    ];

    mpvProcess = spawn(MPV_EXE, args, {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
    });

    mpvProcess.on("exit", () => {
        mpvProcess = null;
        const state = getState();
        state.playing = false;
        saveState(state);
    });

    mpvProcess.on("error", () => {
        mpvProcess = null;
    });
}

// ─── M3U Playlist ─────────────────────────────────────────────────────────────

function buildM3U(files: string[], outputPath: string): void {
    const lines = files.map((f) => `#EXTINF:0,${path.basename(f, path.extname(f))}\n${f}`);
    fs.writeFileSync(outputPath, "#EXTM3U\n" + lines.join("\n"), "utf8");
}

// ─── Library Scanning ─────────────────────────────────────────────────────────

function scanDirectory(dir: string): { added: number; songs: any[] } {
    const files = findAudioFiles(dir);
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

function searchLibrary(query: string): any[] {
    const lib = getLibrary();
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
                "shuffle", "check",
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
            const result = scanDirectory(scanPath);
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

            const lines = lib.map((s: any, i: number) => {
                const dur = formatDuration(s.duration);
                return `${i + 1}. ${s.title} — ${s.artist} [${dur}]`;
            });

            const header = args.query
                ? `Found ${lib.length} song(s) for '${args.query}':\n`
                : `Library (${lib.length} songs):\n`;

            return header + lines.slice(0, 50).join("\n") +
                (lib.length > 50 ? `\n...and ${lib.length - 50} more. Use a search to narrow.` : "");
        }

        // ── PLAY ──────────────────────────────────────────────────────────────
        if (args.action === "play") {
            const state = getState();
            let songs: any[] = [];

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
                    return `No songs found for '${args.query}'. Try \`download\` to grab it from YouTube first.`;
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

            if (songs.length === 0) return "Nothing to play.";

            const filePaths = songs.map((s: any) => s.path);
            buildM3U(filePaths, CURRENT_M3U);

            state.queue = filePaths;
            state.position = 0;
            state.current = songs[0];
            state.playing = true;
            state.volume = state.volume || 50;
            saveState(state);

            startMpv(CURRENT_M3U, state.volume);

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
            stopMpv();
            const state = getState();
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
            try {
                const pos = await getMpvProperty("time-pos");
                const dur = await getMpvProperty("duration");
                if (pos && dur) {
                    timePos = `${formatTime(parseFloat(pos))} / ${formatTime(parseFloat(dur))}`;
                }
            } catch { /* ignore */ }

            const current = state.current;
            const dur = formatDuration(current.duration);
            const prog = timePos || dur;

            return [
                `▶️ Now Playing:`,
                `   ${current.title} — ${current.artist}`,
                `   ${prog} | 🔊 ${state.volume}%`,
                ``,
                `Commands: pause | stop | next | prev | volume [0-100]`,
            ].join("\n");
        }

        // ── DOWNLOAD ──────────────────────────────────────────────────────────
        if (args.action === "download") {
            if (!args.url) return "Error: url is required for download.";

            const output = path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s");
            try {
                // Sanitize URL — remove tracking params that break shell
                const cleanUrl = (args.url || "").split("&")[0];
                const ffmpegDir = path.dirname(FFPROBE_EXE);
                const result = execSync(
                    `"${YTDLP_EXE}" --extract-audio --audio-format mp3 --js-runtimes node --ffmpeg-location "${ffmpegDir}" --output "${output}" "${cleanUrl}"`,
                    { timeout: 300000, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: true }
                );

                // Scan downloads dir to add new songs to library
                const scanResult = scanDirectory(DOWNLOADS_DIR);

                // Extract the downloaded filename from yt-dlp output
                const match = result.match(/Destination:\s*(.+\.mp3)/i);
                const filename = match ? path.basename(match[1]) : "unknown";

                return [
                    `✅ Downloaded: ${filename}`,
                    `📚 Library now has ${scanResult.songs.length} songs`,
                    `▶️ Try: \`play "${path.basename(filename, ".mp3")}"\``,
                ].join("\n");
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

            // create [name]
            if (subAction.startsWith("create ")) {
                const plName = subAction.replace(/^create\s*/i, "").trim();
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

            const favs = getFavorites();
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
            const lib = getLibrary();
            if (lib.length === 0) return "Library is empty.";

            const shuffled = [...lib].sort(() => Math.random() - 0.5);
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

        return `Unknown action '${args.action}'. Available: scan, library, play, pause, stop, next, prev, volume, status, download, playlist, favorite, shuffle, check`;
    },
});
