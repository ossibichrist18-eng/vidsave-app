const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const ytdl = require('@distube/ytdl-core'); // ✅ On utilise ça pour YouTube
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

const app = express();
app.use(cors());
app.use(express.json());

// Health check
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

// --- ROUTE 1 : INFOS VIDÉO ---
app.post('/api/info', async (req, res) => {
    try {
        let url = req.body.url;
        
        // ✅ SI YOUTUBE : Utiliser @distube/ytdl-core (Plus stable sur Render)
        if (isYouTube(url)) {
            if (url.includes('?si=')) url = url.split('?si=')[0];
            const info = await ytdl.getInfo(url);
            const formats = info.formats.filter(f => f.hasVideo && f.height);
            const qualities = [...new Set(formats.map(f => f.height))].sort((a, b) => b - a);
            
            return res.json({
                title: info.videoDetails.title,
                thumbnail: info.videoDetails.thumbnails[0]?.url,
                url: url,
                qualities: qualities.length ? qualities : [720, 480, 360],
                duration: info.videoDetails.lengthSeconds
            });
        }

        // SINON : Utiliser youtube-dl-exec
        const info = await youtubedl(url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true });
        let qualities = new Set();
        if (info.formats) info.formats.forEach(f => { if (f.height >= 144) qualities.add(f.height); });
        
        res.json({
            title: info.title || "Vidéo", thumbnail: info.thumbnail, url: url,
            qualities: Array.from(qualities).sort((a, b) => b - a), duration: info.duration || 0
        });
    } catch (error) {
        console.error("Erreur info:", error.message);
        res.status(500).json({ error: "Impossible d'analyser la vidéo." });
    }
});

// --- ROUTE 2 : PLAYLIST ---
app.post('/api/playlist', async (req, res) => {
    try {
        const info = await youtubedl(req.body.url, { dumpSingleJson: true, yesPlaylist: true, flatPlaylist: true, noWarnings: true });
        if (info.entries) {
            const videos = info.entries.map(e => ({ title: e.title || 'Sans titre', url: e.url || e.webpage_url, duration: e.duration_string || 'Inconnue', thumbnail: e.thumbnail || '' }));
            res.json({ title: info.title, entries: videos });
        } else res.status(404).json({ error: "Pas de vidéos trouvées." });
    } catch (error) {
        res.status(500).json({ error: "Erreur playlist." });
    }
});

// --- ROUTE 3 : TÉLÉCHARGEMENT VIDÉO ---
app.get('/api/start-download', (req, res) => {
    const { url, quality, title, start, end } = req.query;
    const finalTitle = cleanFileName(title || 'Video');
    const jobId = 'dl_' + Date.now();
    const ext = (quality === 'audio' || quality === 'mp3') ? 'mp3' : 'mp4';
    const tempFile = path.join(dlDir, `temp_${jobId}.${ext}`);

    jobs[jobId] = { status: 'downloading', file: tempFile, ext, title: finalTitle, progress: '0', eta: '--:--' };
    res.json({ jobId });

    // ✅ SI YOUTUBE : Utiliser @distube/ytdl-core
    if (isYouTube(url)) {
        let ytdlOptions = { quality: quality === 'audio' ? 'highestaudio' : 'highest' };
        if (quality === 'mp3') ytdlOptions.filter = 'audioonly';
        
        const stream = ytdl(url, ytdlOptions);
        const file = fs.createWriteStream(tempFile);
        
        stream.pipe(file);
        
        stream.on('progress', (chunkLength, downloaded, total) => {
            const percent = (downloaded / total * 100).toFixed(1);
            jobs[jobId].progress = percent;
        });

        file.on('finish', () => {
            file.close();
            // Renommer le fichier
            const finalFile = path.join(dlDir, `${finalTitle}_${jobId}.${ext}`);
            fs.renameSync(tempFile, finalFile);
            jobs[jobId].file = finalFile;
            jobs[jobId].status = 'done';
        });

        stream.on('error', (err) => {
            console.error("Erreur stream ytdl:", err);
            jobs[jobId].status = 'error';
        });
        return; 
    }

    // SINON : Utiliser youtube-dl-exec (pour TikTok, etc.)
    let formatSelection = 'best';
    if (quality === 'mp3') formatSelection = 'bestaudio[ext=m4a]/bestaudio';
    else if (quality && !isNaN(quality)) formatSelection = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`;

    const dlOptions = { f: formatSelection, o: tempFile, ffmpegLocation: path.dirname(ffmpegPath) };
    if (ext === 'mp3') { dlOptions.extractAudio = true; dlOptions.audioFormat = 'mp3'; }

    const proc = youtubedl.exec(url, dlOptions);
    proc.stdout.on('data', (data) => {
        const text = data.toString();
        const match = text.match(/\[download\]\s+([\d\.]+)%/);
        if (match) jobs[jobId].progress = match[1];
    });
    proc.on('close', (code) => {
        if (code !== 0) { jobs[jobId].status = 'error'; return; }
        const finalFile = path.join(dlDir, `${finalTitle}_${jobId}.${ext}`);
        try { fs.renameSync(tempFile, finalFile); jobs[jobId].file = finalFile; } catch(e) {}
        jobs[jobId].status = 'done';
    });
});

// --- ROUTE COBALT (Fallback pour les autres sites si besoin) ---
app.post('/api/cobalt', async (req, res) => {
  try {
    const { url, videoQuality } = req.body;
    // Utiliser une instance Cobalt plus stable ou l'API officielle
    const response = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, videoQuality: videoQuality || '1080' })
    });
    const data = await response.json();
    // Vérification de sécurité pour éviter de télécharger des pages HTML
    if (data.url && (data.url.endsWith('.htm') || data.url.endsWith('.html'))) {
        return res.status(500).json({ error: 'Lien invalide (HTML)' });
    }
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: 'Cobalt error' });
  }
});

// --- ROUTES SECONDAIRES (Miniature, Sous-titres, Conversion, Status, Get-File) ---
// (Je les ai gardées identiques à ton code original pour ne pas casser le reste)
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
        const info = await youtubedl(req.body.url, { dumpSingleJson: true, noWarnings: true, noPlaylist: true });
        const subs = info.subtitles || {};
        const langs = Object.keys(subs).map(l => ({ code: l, name: subs[l][0]?.name || l }));
        res.json({ languages: langs });
    } catch(e) { res.status(500).json({ error: "Erreur sous-titres." }); }
});

app.get('/api/download-sub', (req, res) => {
    const url = req.query.url, lang = req.query.lang || 'fr';
    const subFile = path.join(dlDir, `sub_${Date.now()}.srt`);
    const proc = youtubedl.exec(url, { writeSub: true, subLang: lang, skipDownload: true, o: subFile });
    proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(subFile)) res.download(subFile, `subtitles_${lang}.srt`, () => fs.existsSync(subFile) && fs.unlinkSync(subFile));
        else res.status(500).send("Erreur sous-titres.");
    });
});

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
