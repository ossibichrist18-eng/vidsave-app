const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/ping', (req, res) => res.status(200).send('OK'));
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.sendFile(path.join(__dirname, 'sitemap.xml'));
});
app.get('/googlec29be3f3b9d13ec3.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'googlec29be3f3b9d13ec3.html'));
});
app.use(express.static(path.join(__dirname)));
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(path.join(__dirname, 'robots.txt'));
});

const dlDir = path.join(__dirname, 'downloads');
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir);
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });
const jobs = {};
const ffmpegPath = ffmpegStatic || path.join(__dirname, 'ffmpeg.exe');

function cleanFileName(str) {
  if (!str) return "VideoSave";
  return str.replace(/[\\/:*?"<>|]/g, '').trim().substring(0, 150);
}

// Options yt-dlp pour TikTok, Facebook, Instagram, etc.
const ytOptions = {
  addHeader: [
    'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  ]
};

// ✅ INFOS VIDÉO
app.post('/api/info', async (req, res) => {
  try {
    const info = await youtubedl(req.body.url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true, ...ytOptions });
    let qualities = new Set();
    if (info.formats) info.formats.forEach(f => { if (f.height && f.height >= 144) qualities.add(f.height); });
    res.json({
      title: info.title || "Vidéo",
      thumbnail: info.thumbnail,
      url: req.body.url,
      qualities: Array.from(qualities).sort((a, b) => b - a),
      duration: info.duration || 0
    });
  } catch (error) {
    console.error("❌ Erreur info:", error.message);
    res.status(500).json({ error: "Impossible d'analyser." });
  }
});

// ✅ PLAYLIST
app.post('/api/playlist', async (req, res) => {
  try {
    const info = await youtubedl(req.body.url, { dumpSingleJson: true, yesPlaylist: true, flatPlaylist: true, noWarnings: true, ...ytOptions });
    if (info.entries) {
      const videos = info.entries.map(e => ({ title: e.title || 'Sans titre', url: e.url || e.webpage_url, duration: e.duration_string || '?', thumbnail: e.thumbnail || '' }));
      res.json({ title: info.title, entries: videos });
    } else res.status(404).json({ error: "Aucune vidéo." });
  } catch (error) { res.status(500).json({ error: "Erreur playlist." }); }
});

// ✅ TÉLÉCHARGEMENT
app.get('/api/start-download', (req, res) => {
  const { url, quality, title } = req.query;
  const finalTitle = cleanFileName(title || 'Video');
  const jobId = 'dl_' + Date.now();
  const ext = (quality === 'audio' || quality === 'mp3') ? 'mp3' : 'mp4';
  const tempFile = path.join(dlDir, `temp_${jobId}.${ext}`);

  jobs[jobId] = { status: 'downloading', file: tempFile, ext, title: finalTitle, progress: '0', eta: '--:--' };
  res.json({ jobId });

  let formatSelection = 'best';
  if (quality === 'mp3') formatSelection = 'bestaudio[ext=m4a]/bestaudio';
  else if (quality && !isNaN(quality)) formatSelection = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`;

  const dlOptions = { f: formatSelection, o: tempFile, ffmpegLocation: path.dirname(ffmpegPath), ...ytOptions };
  if (ext === 'mp3') { dlOptions.extractAudio = true; dlOptions.audioFormat = 'mp3'; }

  const proc = youtubedl.exec(url, dlOptions);
  proc.stdout.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/\[download\]\s+([\d\.]+)%/);
    if (match) jobs[jobId].progress = match[1];
  });
  proc.on('close', (code) => {
    if (code !== 0) { jobs[jobId].status = 'error'; console.error('❌ Erreur téléchargement'); return; }
    const finalFile = path.join(dlDir, `${finalTitle}_${jobId}.${ext}`);
    try { fs.renameSync(tempFile, finalFile); jobs[jobId].file = finalFile; } catch(e) {}
    jobs[jobId].status = 'done';
    console.log(`✅ Terminé: ${finalFile}`);
  });
});

// ✅ MINIATURE
app.get('/api/download-thumb', async (req, res) => {
  try {
    const response = await fetch(req.query.url);
    const buffer = await response.buffer();
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.send(buffer);
  } catch (e) { res.status(500).send("Erreur."); }
});

// ✅ SOUS-TITRES
app.post('/api/subtitles', async (req, res) => {
  try {
    const info = await youtubedl(req.body.url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true, ...ytOptions });
    const subs = info.subtitles || {};
    const langs = Object.keys(subs).map(l => ({ code: l, name: subs[l][0]?.name || l }));
    res.json({ languages: langs });
  } catch(e) { res.status(500).json({ error: "Erreur." }); }
});

app.get('/api/download-sub', (req, res) => {
  const url = req.query.url, lang = req.query.lang || 'fr';
  const subFile = path.join(dlDir, `sub_${Date.now()}.srt`);
  const proc = youtubedl.exec(url, { writeSub: true, subLang: lang, skipDownload: true, o: subFile, ...ytOptions });
  proc.on('close', (code) => {
    if (code === 0 && fs.existsSync(subFile)) res.download(subFile, `subtitles_${lang}.srt`, () => fs.existsSync(subFile) && fs.unlinkSync(subFile));
    else res.status(500).send("Erreur.");
  });
});

// ✅ CONVERSION
function runFfmpeg(args, jobId, inputPath) {
  const ff = spawn(ffmpegPath, args);
  ff.on('close', (code) => {
    if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (code === 0) { jobs[jobId].status = 'done'; jobs[jobId].progress = '100'; }
    else jobs[jobId].status = 'error';
  });
}

app.post('/api/convert-to-mp3', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
  const jobId = 'locmp3_' + Date.now();
  const inputPath = req.file.path;
  const outputPath = path.join(dlDir, `AudioConverti_${jobId}.mp3`);
  jobs[jobId] = { status: 'converting', file: outputPath, ext: 'mp3', title: cleanFileName(req.body.originalName), progress: '0' };
  res.json({ jobId });
  runFfmpeg(['-y', '-i', inputPath, '-vn', '-b:a', '192k', outputPath], jobId, inputPath);
});

app.post('/api/convert-video', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
  const jobId = 'locvid_' + Date.now();
  const inputPath = req.file.path;
  const outputPath = path.join(dlDir, `VideoConverti_${jobId}.${req.body.format || 'mp4'}`);
  jobs[jobId] = { status: 'converting', file: outputPath, ext: req.body.format || 'mp4', title: cleanFileName(req.body.originalName), progress: '0' };
  res.json({ jobId });
  runFfmpeg(['-y', '-i', inputPath, outputPath], jobId, inputPath);
});

// ✅ STATUT & FICHIER
app.get('/api/status', (req, res) => {
  const job = jobs[req.query.jobId];
  if (!job) return res.json({ status: 'not_found' });
  res.json({ status: job.status, progress: job.progress, eta: job.eta });
});

app.get('/api/get-file', (req, res) => {
  const job = jobs[req.query.jobId];
  if (!job || job.status !== 'done') return res.status(400).send("Fichier indisponible");
  res.download(job.file, `${job.title}.${job.ext}`, () => {
    if (fs.existsSync(job.file)) fs.unlinkSync(job.file);
    delete jobs[req.query.jobId];
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Serveur prêt sur le port ${PORT}`));
