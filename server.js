const express = require('express');
const { exec } = require('child_process');
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('FFmpeg HLS server is running. GET /start to begin conversion.');
});

app.get('/start', (req, res) => {
  const cmd = `ffmpeg -i "http://line.candycloudlion.top/34610a08/5a54c0c6/577445.ts" \
    -vf "yadif=1:-1:0,format=yuv420p" \
    -flags +ilme+ildct \
    -top 1 \
    -r 30000/1001 \
    -s 720x576 \
    -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 128k \
    -f hls \
    -hls_time 10 \
    -hls_list_size 0 \
    -hls_segment_filename "segment_%03d.ts" \
    "playlist.m3u8"`;

  exec(cmd, { cwd: '/app' }, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error}`);
      return;
    }
    console.log(`FFmpeg finished`);
  });

  res.json({ success: true, message: 'FFmpeg conversion started. Check playlist.m3u8' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`FFmpeg HLS server running on port ${PORT}`);
});
