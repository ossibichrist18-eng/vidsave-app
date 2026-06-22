const express = require('express');
const cors = require('cors');
const youtubedl = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

const app = express();
app.use(cors());
app.use(express.json());

// Endpoint ping pour health check (cron-job.org)
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

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
console.log('🔍 FFmpeg utilisé :', ffmpegPath);

const agentOptions = {
    addHeader: [
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language:fr-FR,fr;q=0.9,en;q=0.8'
    ]
};

function cleanFileName(str) {
    if (!str) return "VideoSave_Download";
    return str.replace(/[\\/:*?"<>|]/g, '').trim().substring(0, 150);
}

// ============================================
// ✅ ROUTE COBALT — Instance fiable + gestion d'erreur
// ============================================
app.post('/api/cobalt', async (req, res) => {
  try {
    const { url, videoQuality, downloadMode } = req.body;
    const isAudio = downloadMode === 'audio';

    // Essayer plusieurs instances Cobalt (fallback automatique)
    const instances = [
      'https://cobalt.tools.fopnet.fr/',
      'https://api.cobalt.tools/',
    ];

    let lastError = null;
    for (const instance of instances) {
      try {
        const response = await fetch(instance, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url,
            videoQuality: videoQuality || '1080',
            filenameStyle: 'pretty',
            ...(isAudio ? { downloadMode: 'audio', audioFormat: 'mp3' } : {})
          })
        });

        const data = await response.json();

        // Vérifier que c'est bien un JSON valide avec une URL
        if (data && (data.status === 'redirect' || data.status === 'stream') && data.url) {
          // S'assurer que l'URL n'est pas une page HTML
          if (data.url.endsWith('.htm') || data.url.endsWith('.html')) {
            lastError = 'Cobalt a renvoyé une page HTML';
            continue;
          }
          return res.json(data);
        }

        if (data && data.status === 'error') {
          lastError = data.error?.text || data.error?.code || 'Erreur Cobalt';
          continue;
        }

        lastError = 'Réponse Cobalt invalide';
      } catch (e) {
        lastError = e.message;
        continue;
      }
    }

    // Si toutes les instances Cobalt échouent, fallback vers yt-dlp direct
    console.log('⚠️ Cobalt échoué, fallback vers yt-dlp direct');
    return res.json({ status: 'fallback', error: lastError });

  } catch(e) {
    console.error('❌ Cobalt proxy error:', e.message);
    res.status(500).json({ error: 'Cobalt proxy error: ' + e.message });
  }
});

// ============================================
// ✅ ROUTE 1 : INFOS VIDÉO (yt-dlp)
// ============================================
app.post('/api/info', async (req, res) => {
    try {
        let url = req.body.url;
        if (url.includes('youtu') && url.includes('?si=')) url = url.split('?si=')[0];
        const info = await youtubedl(url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true, ...agentOptions });
        let qualities = new Set();
        if (info.formats) info.formats.forEach(f => { if (f.height && f.height >= 144) qualities.add(f.height); });
        res.json({
            title: info.title || "Vidéo",
            thumbnail: info.thumbnail,
            url: url,
            qualities: Array.from(qualities).sort((a, b) => b - a),
            duration: info.duration || 0
        });
    } catch (error) {
        console.error('Erreur /api/info:', error.message);
        res.status(500).json({ error: "Impossible d'analyser la vidéo." });
    }
});

// ============================================
// ✅ ROUTE 2 : PLAYLIST
// ============================================
app.post('/api/playlist', async (req, res) => {
    try {
        const info = await youtubedl(req.body.url, { dumpSingleJson: true, yesPlaylist: true, flatPlaylist: true, noWarnings: true, ...agentOptions });
        if (info.entries) {
            const videos = info.entries.map(e => ({ title: e.title || 'Sans titre', url: e.url || e.webpage_url, duration: e.duration_string || 'Inconnue', thumbnail: e.thumbnail || '' }));
            res.json({ title: info.title, entries: videos });
        } else res.status(404).json({ error: "Pas de vidéos trouvées." });
    } catch (error) {
        res.status(500).json({ error: "Erreur playlist." });
    }
});

// ============================================
// ✅ ROUTE 3 : TÉLÉCHARGEMENT VIDÉO (yt-dlp backend)
// ============================================
app.get('/api/start-download', (req, res) => {
    const { url, quality, title, start, end } = req.query;
    const finalTitle = cleanFileName(title || 'Video');
    const startSec = parseFloat(start) || 0;
    const endSec = parseFloat(end) || 0;
    const jobId = 'dl_' + Date.now();
    let formatSelection, ext = 'mp4';

    if (quality === 'audio' || quality === 'mp3') {
        formatSelection = 'bestaudio/best';
        ext = 'mp3';
    } else if (!quality || isNaN(quality) || quality === 'best') {
        formatSelection = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    } else {
        formatSelection = `bestvideo[vcodec^=avc][height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[vcodec^=avc][height<=${quality}][ext=mp4]/best[height<=${quality}]`;
    }

    const tempFile = path.join(dlDir, `temp_${jobId}.${ext}`);
    jobs[jobId] = { status: 'downloading', file: tempFile, ext, title: finalTitle, progress: '0', eta: '--:--' };
    res.json({ jobId });

    const dlOptions = { f: formatSelection, o: tempFile, ffmpegLocation: path.dirname(ffmpegPath), ...agentOptions };
    if (ext === 'mp4') dlOptions.mergeOutputFormat = 'mp4';
    if (ext === 'mp3') { dlOptions.extractAudio = true; dlOptions.audioFormat = 'mp3'; }

    const proc = youtubedl.exec(url, dlOptions);
    proc.stdout.on('data', (data) => {
        const text = data.toString();
        const match = text.match(/\[download\]\s+([\d\.]+)%/);
        const etaMatch = text.match(/ETA\s+([\d:]+)/);
        if (match) jobs[jobId].progress = match[1];
        if (etaMatch) jobs[jobId].eta = etaMatch[1];
    });
    proc.stderr.on('data', (data) => {
        console.log('[yt-dlp stderr]', data.toString().trim());
    });
    proc.on('close', (code) => {
        if (code !== 0) { jobs[jobId].status = 'error'; return; }
        if ((startSec > 0 || endSec > 0) && ext === 'mp4') {
            jobs[jobId].status = 'trimming';
            const trimmed = path.join(dlDir, `Video_${jobId}.mp4`);
            const args = ['-y', '-i', tempFile, '-ss', startSec.toString(), '-to', endSec.toString(), '-c', 'copy', trimmed];
            const ff = spawn(ffmpegPath, args);
            ff.stderr.on('data', d => console.error('FFmpeg trim:', d.toString()));
            ff.on('close', (c) => {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                if (c === 0) { jobs[jobId].file = trimmed; jobs[jobId].status = 'done'; }
                else jobs[jobId].status = 'error';
            });
        } else {
            const finalFile = path.join(dlDir, `${finalTitle}_${jobId}.${ext}`);
            try { fs.renameSync(tempFile, finalFile); jobs[jobId].file = finalFile; } catch(e) {}
            jobs[jobId].status = 'done';
        }
    });
});

// ============================================
// ✅ ROUTE 4 : MINIATURE
// ============================================
app.get('/api/download-thumb', async (req, res) => {
    try {
        const response = await fetch(req.query.url);
        if (!response.ok) throw new Error('Erreur fetch');
        const buffer = await response.buffer();
        res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
        res.set('Content-Disposition', 'attachment; filename="thumbnail.jpg"');
        res.send(buffer);
    } catch (e) { res.status(500).send("Erreur miniature."); }
});

// ============================================
// ✅ ROUTE 5 : SOUS-TITRES
// ============================================
app.post('/api/subtitles', async (req, res) => {
    try {
        const info = await youtubedl(req.body.url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true, ...agentOptions });
        const subs = info.subtitles || {};
        const langs = Object.keys(subs).map(l => ({ code: l, name: subs[l][0]?.name || l }));
        res.json({ languages: langs });
    } catch(e) { res.status(500).json({ error: "Erreur sous-titres." }); }
});

// ============================================
// ✅ ROUTE 6 : TÉLÉCHARGER SOUS-TITRES
// ============================================
app.get('/api/download-sub', (req, res) => {
    const url = req.query.url, lang = req.query.lang || 'fr';
    const subFile = path.join(dlDir, `sub_${Date.now()}.srt`);
    const proc = youtubedl.exec(url, { writeSub: true, subLang: lang, skipDownload: true, o: subFile, ...agentOptions });
    proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(subFile)) res.download(subFile, `subtitles_${lang}.srt`, () => fs.existsSync(subFile) && fs.unlinkSync(subFile));
        else res.status(500).send("Erreur téléchargement sous-titres.");
    });
});

// ============================================
// ✅ CONVERSION MP3
// ============================================
function runFfmpeg(args, res, jobId, inputPath) {
    const ff = spawn(ffmpegPath, args);
    let stderr = '';
    ff.stderr.on('data', (data) => {
        stderr += data.toString();
    });
    ff.on('close', (code) => {
        if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (code === 0) {
            jobs[jobId].status = 'done';
            jobs[jobId].progress = '100';
        } else {
            console.error(`❌ FFmpeg erreur (code ${code}) :`, stderr);
            jobs[jobId].status = 'error';
        }
    });
}

app.post('/api/convert-to-mp3', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
    const jobId = 'locmp3_' + Date.now();
    const inputPath = req.file.path;
    const outputPath = path.join(dlDir, `AudioConverti_${jobId}.mp3`);
    const finalTitle = cleanFileName((req.body.originalName || 'Audio').replace(/\.[^/.]+$/, ""));
    jobs[jobId] = { status: 'converting', file: outputPath, ext: 'mp3', title: finalTitle, progress: '0', eta: '' };
    res.json({ jobId });
    const args = ['-y', '-i', inputPath, '-vn', '-b:a', '192k', outputPath];
    runFfmpeg(args, res, jobId, inputPath);
});

// ============================================
// ✅ CONVERSION VIDÉO
// ============================================
app.post('/api/convert-video', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Fichier manquant" });
    const outputFormat = req.body.format || 'mp4';
    const start = parseFloat(req.body.start) || 0;
    const end = parseFloat(req.body.end) || 0;
    const jobId = 'locvid_' + Date.now();
    const inputPath = req.file.path;
    const outputPath = path.join(dlDir, `VideoConverti_${jobId}.${outputFormat}`);
    const finalTitle = cleanFileName((req.body.originalName || 'Video').replace(/\.[^/.]+$/, ""));
    jobs[jobId] = { status: 'converting', file: outputPath, ext: outputFormat, title: finalTitle, progress: '0', eta: '' };
    res.json({ jobId });
    const args = ['-y'];
    if (start > 0) args.push('-ss', start.toString());
    args.push('-i', inputPath);
    if (end > 0) args.push('-to', end.toString());
    if (outputFormat === 'mp4') args.push('-c:v', 'libx264', '-c:a', 'aac');
    else if (outputFormat === 'webm') args.push('-c:v', 'libvpx-vp9', '-c:a', 'libopus');
    else if (outputFormat === 'avi') args.push('-c:v', 'libxvid', '-c:a', 'mp3');
    else args.push('-c', 'copy');
    args.push(outputPath);
    runFfmpeg(args, res, jobId, inputPath);
});

// ============================================
// ✅ STATUT
// ============================================
app.get('/api/status', (req, res) => {
    const job = jobs[req.query.jobId];
    if (!job) return res.json({ status: 'not_found' });
    res.json({ status: job.status, progress: job.progress, eta: job.eta });
});

// ============================================
// ✅ TÉLÉCHARGEMENT FINAL
// ============================================
app.get('/api/get-file', (req, res) => {
    const job = jobs[req.query.jobId];
    if (!job || job.status !== 'done') return res.status(400).send("Fichier indisponible");
    res.download(job.file, `${job.title}.${job.ext}`, () => {
        if (fs.existsSync(job.file)) fs.unlinkSync(job.file);
        delete jobs[req.query.jobId];
    });
});

// ============================================
// ✅ PORT
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Serveur prêt sur le port ${PORT}`));
