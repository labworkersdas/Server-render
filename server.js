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
// the source is used by ffmpeg only. it is never logged and never served
// in any HTTP response. override it with the SOURCE_URL env var.
const SOURCE_URL =
  process.env.SOURCE_URL ||
  'http://line.candycloudlion.top/34610a08/5a54c0c6/577430.ts';
const AUTO_START = process.env.AUTO_START !== 'false';
const AUTO_RESTART = process.env.AUTO_RESTART !== 'false';
const HLS_TIME = process.env.HLS_TIME || '10';
const HLS_LIST_SIZE = process.env.HLS_LIST_SIZE || '6';
// 576i/SD at 25fps. ultrafast keeps this realtime on slow shared CPU.
const SIZE = process.env.SIZE || '720x576';
const FPS = process.env.FPS || '25';
const CRF = process.env.CRF || '22';
const GOP = process.env.GOP || '50';
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
  const args = ['-hide_banner', '-loglevel', process.env.FFMPEG_LOGLEVEL || 'info'];
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
  args.push(
    '-i', SOURCE_URL,
    '-vf', `scale=${SIZE}`,
    '-r', FPS,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', CRF,
    '-pix_fmt', 'yuv420p',
    '-g', GOP,
    '-keyint_min', GOP,
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
  if (!SOURCE_URL) {
    console.error('[hls] SOURCE_URL is not set');
    return { started: false, reason: 'SOURCE_URL is not set' };
  }
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
  res.type('html').send('');
});

// control endpoints require ADMIN_TOKEN. fail closed if it is not set.
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).type('text/plain').send('admin disabled');
  }
  const given = req.get('x-admin-token') || req.query.token;
  if (given !== expected) {
    return res.status(404).type('text/plain').send('not found');
  }
  next();
}

app.get('/status', requireAdmin, (req, res) => {
  res.json({
    running: isRunning(),
    pid: isRunning() ? proc.pid : null,
    uptimeMs: startedAt ? Date.now() - startedAt : null,
    restarts,
    playlist: playlistState(),
    lastLog,
  });
});

app.post('/start', requireAdmin, (req, res) => {
  res.json({ ...start('admin'), playlistUrl: '/playlist.m3u8' });
});

app.post('/stop', requireAdmin, (req, res) => {
  res.json(stop());
});

// explicit route so we can return a helpful error before the file exists
app.get('/playlist.m3u8', (req, res) => {
  const st = playlistState();
  if (!st.ready) {
    res.set('Retry-After', '2');
    return res.status(503).type('text/plain').send('not ready');
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
  res.status(404).type('text/plain').send('not found');
});

// ---------- boot ----------
app.listen(PORT, HOST, () => {
  console.log(`[hls] FFmpeg HLS server running on port ${PORT}`);
  console.log(`[hls] output dir: ${OUTPUT_DIR}`);
  console.log(`[hls] playlist URL: http://${HOST}:${PORT}/playlist.m3u8`);
  console.log(`[hls] auto_start=${AUTO_START} auto_restart=${AUTO_RESTART}`);
  console.log(`[hls] SOURCE_URL is ${SOURCE_URL ? 'set' : 'MISSING'}`);
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
