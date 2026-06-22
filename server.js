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

function isYouTube(url) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

// Options pour contourner la détection de bot YouTube
const ytOptions = {
  extractorArgs: 'youtube:player_client=ios,web',
  addHeader: [
    'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language:fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding:gzip, deflate, br'
  ]
};

// ✅ ROUTE 1 : INFOS VIDÉO
app.post('/api/info', async (req, res) => {
  try {
    let url = req.body.url;
    if (url.includes('?si=')) url = url.split('?si=')[0];
    
    const info = await youtubedl(url, { 
      dumpSingleJson: true, 
      noWarnings: true, 
      noPlaylist: true,
      ...ytOptions
    });
    
    let qualities = new Set();
    if (info.formats) {
      info.formats.forEach(f => { 
        if (f.height && f.height >= 144) qualities.add(f.height); 
      });
    }
    
    res.json({
      title: info.title || "Vidéo",
      thumbnail: info.thumbnail,
      url: url,
      qualities: Array.from(qualities).sort((a, b) => b - a),
      duration: info.duration || 0
    });
  } catch (error) {
    console.error("❌ Erreur /api/info:", error.message);
    // Fallback avec d'autres options
    try {
      const info = await youtubedl(url, { 
        dumpSingleJson: true, 
        noWarnings: true, 
        noPlaylist: true,
        extractorArgs: 'youtube:player_client=tv_embedded',
        addHeader: ['User-Agent:com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)']
      });
      
      let qualities = new Set();
      if (info.formats) {
        info.formats.forEach(f => { 
          if (f.height && f.height >= 144) qualities.add(f.height); 
        });
      }
      
      res.json({
        title: info.title || "Vidéo",
        thumbnail: info.thumbnail,
        url: url,
        qualities: Array.from(qualities).sort((a, b) => b - a),
        duration: info.duration || 0
      });
    } catch (error2) {
      console.error("❌ Erreur fallback:", error2.message);
      res.status(500).json({ error: "Impossible d'analyser la vidéo. YouTube bloque temporairement les requêtes." });
    }
  }
});

// ✅ ROUTE 2 : PLAYLIST
app.post('/api/playlist', async (req, res) => {
  try {
    const info = await youtubedl(req.body.url, { 
      dumpSingleJson: true, 
      yesPlaylist: true, 
      flatPlaylist: true, 
      noWarnings: true,
      ...ytOptions
    });
    if (info.entries) {
      const videos = info.entries.map(e => ({ 
        title: e.title || 'Sans titre', 
        url: e.url || e.webpage_url, 
        duration: e.duration_string || 'Inconnue', 
        thumbnail: e.thumbnail || '' 
      }));
      res.json({ title: info.title, entries: videos });
    } else res.status(404).json({ error: "Pas de vidéos trouvées." });
  } catch (error) {
    res.status(500).json({ error: "Erreur playlist." });
  }
});

// ✅ ROUTE 3 : TÉLÉCHARGEMENT VIDÉO
app.get('/api/start-download', (req, res) => {
  const { url, quality, title, start, end } = req.query;
  const finalTitle = cleanFileName(title || 'Video');
  const jobId = 'dl_' + Date.now();
  const ext = (quality === 'audio' || quality === 'mp3') ? 'mp3' : 'mp4';
  const tempFile = path.join(dlDir, `temp_${jobId}.${ext}`);

  jobs[jobId] = { status: 'downloading', file: tempFile, ext, title: finalTitle, progress: '0', eta: '--:--' };
  res.json({ jobId });

  let formatSelection = 'best';
  if (quality === 'mp3') {
    formatSelection = 'bestaudio[ext=m4a]/bestaudio';
  } else if (quality && !isNaN(quality)) {
    formatSelection = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`;
  }

  const dlOptions = { 
    f: formatSelection, 
    o: tempFile, 
    ffmpegLocation: path.dirname(ffmpegPath),
    ...ytOptions
  };
  
  if (ext === 'mp3') { 
    dlOptions.extractAudio = true; 
    dlOptions.audioFormat = 'mp3'; 
  }

  const proc = youtubedl.exec(url, dlOptions);
  
  proc.stdout.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/\[download\]\s+([\d\.]+)%/);
    if (match) jobs[jobId].progress = match[1];
  });
  
  proc.stderr.on('data', (data) => {
    console.log('[yt-dlp]', data.toString().trim());
  });
  
  proc.on('close', (code) => {
    if (code !== 0) { 
      jobs[jobId].status = 'error'; 
      console.error(`❌ yt-dlp a échoué avec code ${code}`);
      return; 
    }
    const finalFile = path.join(dlDir, `${finalTitle}_${jobId}.${ext}`);
    try { 
      fs.renameSync(tempFile, finalFile); 
      jobs[jobId].file = finalFile; 
    } catch(e) {
      console.error('Erreur rename:', e);
    }
    jobs[jobId].status = 'done';
    console.log(`✅ Téléchargement terminé: ${finalFile}`);
  });
});

// ✅ ROUTE COBALT (fallback pour autres plateformes)
app.post('/api/cobalt', async (req, res) => {
  try {
    const { url, videoQuality } = req.body;
    const response = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: { 
        'Accept': 'application/json', 
        'Content-Type': 'application/json',
        'User-Agent': 'VideoSave/1.0'
      },
      body: JSON.stringify({ 
        url, 
        videoQuality: videoQuality || '1080',
        filenameStyle: 'pretty'
      })
    });
    const data = await response.json();
    if (data.url && (data.url.endsWith('.htm') || data.url.endsWith('.html'))) {
      return res.status(500).json({ error: 'Lien invalide' });
    }
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: 'Cobalt error: ' + e.message });
  }
});

// ✅ ROUTES SECONDAIRES
app.get('/api/download-thumb', async (req, res) => {
  try {
    const response = await fetch(req.query.url);
    const buffer = await response.buffer();
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.send(buffer);
  } catch (e) { res.status(500).send("Erreur miniature."); }
});

app.post('/api/subtitles', async (req, res) => {
  try {
    const info = await youtubedl(req.body.url, { 
      dumpSingleJson: true, 
      noWarnings: true, 
      noPlaylist: true,
      ...ytOptions
    });
    const subs = info.subtitles || {};
    const langs = Object.keys(subs).map(l => ({ code: l, name: subs[l][0]?.name || l }));
    res.json({ languages: langs });
  } catch(e) { res.status(500).json({ error: "Erreur sous-titres." }); }
});

app.get('/api/download-sub', (req, res) => {
  const url = req.query.url, lang = req.query.lang || 'fr';
  const subFile = path.join(dlDir, `sub_${Date.now()}.srt`);
  const proc = youtubedl.exec(url, { 
    writeSub: true, 
    subLang: lang, 
    skipDownload: true, 
    o: subFile,
    ...ytOptions
  });
  proc.on('close', (code) => {
    if (code === 0 && fs.existsSync(subFile)) {
      res.download(subFile, `subtitles_${lang}.srt`, () => {
        if (fs.existsSync(subFile)) fs.unlinkSync(subFile);
      });
    } else {
      res.status(500).send("Erreur sous-titres.");
    }
  });
});

// ✅ CONVERSION
function runFfmpeg(args, jobId, inputPath) {
  const ff = spawn(ffmpegPath, args);
  ff.on('close', (code) => {
    if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (code === 0) { 
      jobs[jobId].status = 'done'; 
      jobs[jobId].progress = '100'; 
    } else {
      jobs[jobId].status = 'error';
    }
  });
}

app.post('/api/convert-to-mp3', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
  const jobId = 'locmp3_' + Date.now();
  const inputPath = req.file.path;
  const outputPath = path.join(dlDir, `AudioConverti_${jobId}.mp3`);
  jobs[jobId] = { 
    status: 'converting', 
    file: outputPath, 
    ext: 'mp3', 
    title: cleanFileName(req.body.originalName), 
    progress: '0' 
  };
  res.json({ jobId });
  runFfmpeg(['-y', '-i', inputPath, '-vn', '-b:a', '192k', outputPath], jobId, inputPath);
});

app.post('/api/convert-video', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
  const jobId = 'locvid_' + Date.now();
  const inputPath = req.file.path;
  const outputPath = path.join(dlDir, `VideoConverti_${jobId}.${req.body.format || 'mp4'}`);
  jobs[jobId] = { 
    status: 'converting', 
    file: outputPath, 
    ext: req.body.format || 'mp4', 
    title: cleanFileName(req.body.originalName), 
    progress: '0' 
  };
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
