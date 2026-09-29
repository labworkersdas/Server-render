const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// ---------- config ----------
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, 'hls');
const SOURCE_URL =
  process.env.SOURCE_URL ||
  'http://line.candycloudlion.top/34610a08/5a54c0c6/577445.ts';
const AUTO_START = process.env.AUTO_START !== 'false';
const AUTO_RESTART = process.env.AUTO_RESTART !== 'false';
const HLS_TIME = process.env.HLS_TIME || '10';
const HLS_LIST_SIZE = process.env.HLS_LIST_SIZE || '6';
const PRESET = process.env.PRESET || 'fast';
const DEINTERLACE = process.env.YADIF === '1';
const PLAYLIST = path.join(OUTPUT_DIR, 'playlist.m3u8');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------- ffmpeg state ----------
let proc = null;
let lastLog = [];
let restarts = 0;
let stoppedByUs = false;
let startedAt = null;

function isRunning() {
  return !!proc && proc.exitCode === null && proc.signalCode === null;
}

function buildArgs() {
  const args = ['-hide_banner', '-loglevel', 'warning'];
  // reconnect flags are only valid for http(s) inputs
  if (/^https?:/i.test(SOURCE_URL)) {
    args.push(
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5'
    );
  }
  // interlaced (tff) output, no deinterlacing.
  // set YADIF=1 to deinterlace instead.
  const vf = DEINTERLACE
    ? 'yadif=1:-1:0,setfield=tff,format=yuv420p'
    : 'setfield=tff,format=yuv420p';

  args.push(
    '-i', SOURCE_URL,
    '-vf', vf,
    '-flags', '+ilme+ildct',
    '-r', '30000/1001',
    '-s', '720x576',
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-g', '50',
    '-keyint_min', '50',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', HLS_TIME,
    '-hls_list_size', HLS_LIST_SIZE,
    '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
    '-hls_segment_filename', path.join(OUTPUT_DIR, 'segment_%03d.ts'),
    PLAYLIST
  );
  return args;
}

function start(trigger = 'manual') {
  if (isRunning()) {
    return { started: false, reason: 'already running', pid: proc.pid };
  }

  stoppedByUs = false;
  startedAt = Date.now();
  lastLog = [];

  console.log(`[hls] starting ffmpeg (${trigger}) -> ${PLAYLIST}`);
  proc = spawn('ffmpeg', buildArgs(), { cwd: OUTPUT_DIR });

  proc.stdout.on('data', (d) => pushLog(d));
  proc.stderr.on('data', (d) => pushLog(d));

  proc.on('error', (err) => {
    lastLog.push(`spawn error: ${err.message}`);
    console.error(`[hls] ffmpeg spawn error: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    console.warn(`[hls] ffmpeg exited code=${code} signal=${signal}`);
    proc = null;
    if (stoppedByUs || !AUTO_RESTART) return;
    const delay = Math.min(5000 * Math.max(1, restarts), 30000);
    restarts += 1;
    console.warn(`[hls] restarting in ${delay / 1000}s (restart #${restarts})`);
    setTimeout(() => start('auto-restart'), delay);
  });

  return { started: true, pid: proc.pid, playlist: '/playlist.m3u8' };
}

function stop() {
  if (!isRunning()) return { stopped: false, reason: 'not running' };
  stoppedByUs = true;
  const pid = proc.pid;
  try {
    proc.kill('SIGTERM');
  } catch (_) {}
  setTimeout(() => {
    if (isRunning()) {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
    }
  }, 3000);
  return { stopped: true, pid };
}

function pushLog(buf) {
  const text = buf.toString();
  process.stdout.write(`[ffmpeg] ${text}`);
  for (const line of text.split('\n')) {
    if (line.trim()) lastLog.push(line.trim());
  }
  if (lastLog.length > 20) lastLog = lastLog.slice(-20);
}

function playlistState() {
  if (!fs.existsSync(PLAYLIST)) return { ready: false, reason: 'not created yet' };
  const size = fs.statSync(PLAYLIST).size;
  if (size === 0) return { ready: false, reason: 'ffmpeg has not finished the first segment' };
  const segments = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => /^segment_\d+\.ts$/.test(f));
  return { ready: true, size, segments: segments.length };
}

// ---------- routes ----------
app.get('/', (req, res) => {
  const st = playlistState();
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>FFmpeg HLS</title>
<style>body{font:14px/1.6 monospace;background:#111;color:#eee;padding:24px}
a{color:#6cf}code{background:#222;padding:2px 5px;border-radius:3px}</style>
<h1>FFmpeg HLS server</h1>
<p>status: <b>${isRunning() ? 'transcoding' : 'stopped'}</b></p>
<p>playlist: <b>${st.ready ? 'ready' : st.reason}</b>${
    st.ready ? ` (${st.segments} segments)` : ''
  }</p>
<p>source: <code>${SOURCE_URL}</code></p>
<ul>
  <li><a href="/playlist.m3u8">/playlist.m3u8</a></li>
  <li><a href="/status">/status</a> (JSON)</li>
  <li><a href="/start">/start</a></li>
  <li><a href="/stop">/stop</a></li>
</ul>`);
});

app.get('/status', (req, res) => {
  res.json({
    running: isRunning(),
    pid: isRunning() ? proc.pid : null,
    uptimeMs: startedAt ? Date.now() - startedAt : null,
    restarts,
    source: SOURCE_URL,
    outputDir: OUTPUT_DIR,
    playlist: playlistState(),
    lastLog,
  });
});

app.get('/start', (req, res) => {
  res.json({ ...start('http /start'), playlistUrl: '/playlist.m3u8' });
});

app.get('/stop', (req, res) => {
  res.json(stop());
});

// explicit route so we can return a helpful error before the file exists
app.get('/playlist.m3u8', (req, res) => {
  const st = playlistState();
  if (!st.ready) {
    res.set('Retry-After', '2');
    return res.status(503).type('text/plain').send(
      `playlist not ready: ${st.reason}\n` +
        `ffmpeg running: ${isRunning()}\n` +
        `The first segment takes about ${HLS_TIME}s of video to encode.\n` +
        `Check /status for logs, or hit /start.`
    );
  }
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('application/vnd.apple.mpegurl');
  res.sendFile(PLAYLIST);
});

// serve the .ts segments and anything else produced in the output dir
app.use(
  express.static(OUTPUT_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'public, max-age=60');
      }
    },
  })
);

app.use((req, res) => {
  res.status(404).type('text/plain').send(`Cannot GET ${req.path}\nRoutes: / /start /stop /status /playlist.m3u8`);
});

// ---------- boot ----------
app.listen(PORT, HOST, () => {
  console.log(`[hls] FFmpeg HLS server running on port ${PORT}`);
  console.log(`[hls] output dir: ${OUTPUT_DIR}`);
  console.log(`[hls] playlist URL: http://${HOST}:${PORT}/playlist.m3u8`);
  if (AUTO_START) {
    setTimeout(() => start('boot'), 1500);
  }
});

process.on('SIGTERM', () => {
  stoppedByUs = true;
  if (isRunning()) {
    try {
      proc.kill('SIGTERM');
    } catch (_) {}
  }
  process.exit(0);
});
