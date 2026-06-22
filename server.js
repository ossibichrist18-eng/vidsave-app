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

const dlDir = path.join(__dirname, 'downloads');
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir);
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });
const jobs = {};
const ffmpegPath = ffmpegStatic || path.join(__dirname, 'ffmpeg.exe');

function cleanFileName(str) {
  if (!str) return "VideoSave_Download";
  return str.replace(/[\\/:*?"<>|]/g, '').trim().substring(0, 150);
}

// ✅ ASTUCE : Utiliser le client 'android' ou 'tv_embedded' pour contourner les blocages
const ytOptions = {
  extractorArgs: 'youtube:player_client=android', 
  addHeader: [
    'User-Agent:com.google.android.youtube/19.09.36 (Linux; U; Android 14) gzip',
    'Accept-Language:fr-FR,fr;q=0.9'
  ]
};

// ✅ ROUTE 1 : INFOS VIDÉO
app.post('/api/info', async (req, res) => {
  try {
    let url = req.body.url;
    if (url.includes('?si=')) url = url.split('?si=')[0];
    
    // Essai 1 : Client Android
    try {
      const info = await youtubedl(url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true, ...ytOptions });
      return sendInfoResponse(res, info, url);
    } catch (e1) {
      console.log("Tentative Android échouée, passage à TV...");
      // Essai 2 : Client TV (souvent moins bloqué)
      const info = await youtubedl(url, { 
        dumpSingleJson: true, noWarnings: true, noPlaylist: true,
        extractorArgs: 'youtube:player_client=tv_embedded'
      });
      return sendInfoResponse(res, info, url);
    }
  } catch (error) {
    console.error("❌ Erreur critique info:", error.message);
    res.status(500).json({ error: "YouTube bloque ce serveur temporairement. Réessaie dans 1h." });
  }
});

function sendInfoResponse(res, info, url) {
  let qualities = new Set();
  if (info.formats) info.formats.forEach(f => { if (f.height && f.height >= 144) qualities.add(f.height); });
  res.json({
    title: info.title || "Vidéo",
    thumbnail: info.thumbnail,
    url: url,
    qualities: Array.from(qualities).sort((a, b) => b - a),
    duration: info.duration || 0
  });
}

// ✅ ROUTE 3 : TÉLÉCHARGEMENT (Même logique : Android puis TV)
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

  const dlOptions = { 
    f: formatSelection, 
    o: tempFile, 
    ffmpegLocation: path.dirname(ffmpegPath),
    ...ytOptions // Utilise Android par défaut
  };
  
  if (ext === 'mp3') { dlOptions.extractAudio = true; dlOptions.audioFormat = 'mp3'; }

  console.log(`🚀 Lancement téléchargement pour ${jobId}...`);
  const proc = youtubedl.exec(url, dlOptions);
  
  proc.stdout.on('data', (data) => {
    const text = data.toString();
    // Cherche le pourcentage
    const match = text.match(/\[download\]\s+([\d\.]+)%/);
    if (match) {
      jobs[jobId].progress = match[1];
      console.log(`Progression ${jobId}: ${match[1]}%`);
    }
  });

  proc.on('close', (code) => {
    if (code !== 0) { 
      console.error(`❌ Echec téléchargement code ${code}`);
      jobs[jobId].status = 'error'; 
      return; 
    }
    const finalFile = path.join(dlDir, `${finalTitle}_${jobId}.${ext}`);
    try { fs.renameSync(tempFile, finalFile); jobs[jobId].file = finalFile; } catch(e) {}
    jobs[jobId].status = 'done';
    console.log(`✅ Succès: ${finalFile}`);
  });
});

// ... (Le reste des routes cobalt, conversion, etc. reste identique, je ne le répète pas pour gagner de la place, garde ton code actuel pour les autres routes) ...
// Assure-toi de garder les routes /api/cobalt, /api/status, /api/get-file, etc.

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
