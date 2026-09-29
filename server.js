const express = require('express');
const { exec } = require('child_process');
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('FFmpeg server is running. POST to /convert with {input, output, options}');
});

app.post('/convert', (req, res) => {
  const { input, output, options = '' } = req.body;
  const cmd = `ffmpeg -i ${input} ${options} ${output}`;
  
  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: stderr });
    }
    res.json({ success: true, output: output });
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`FFmpeg server running on port ${PORT}`);
});
