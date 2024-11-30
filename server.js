const express = require('express');
const WebTorrent = require('webtorrent');
const AWS = require('aws-sdk');
const got = require('got');
const { createWriteStream } = require('fs');
const socketIO = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = require('http').createServer(app);
app.use(express.json()); // This line is crucial for parsing JSON bodies
app.use(express.urlencoded({ extended: true })); // For parsing URL-encoded bodies

// Add some debug logging
app.use((req, res, next) => {
  console.log('Request Body:', req.body);
  console.log('Content-Type:', req.headers['content-type']);
  next();
});
const corsOptions = {
  origin: '*', // Your React app URL
  methods: ['GET', 'POST'],
  credentials: true
};

// Apply CORS to Express
app.use(cors(corsOptions));

const io = socketIO(server, {
  cors: {
    origin: 'http://localhost:3001',
    methods: ['GET', 'POST'],
    credentials: true
  }
});
// Configure AWS
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  endpoint: 'https://usc1.contabostorage.com', // Contabo endpoint
  s3ForcePathStyle: true, // Required for Contabo
  signatureVersion: 'v4',
  region: 'us-east-1' // This can be any valid region as we're using a custom endpoint
});

const client = new WebTorrent();

// Store active downloads
const activeDownloads = new Map();

app.post('/api/download', async (req, res) => {
  const { url, type, fileName } = req.body;
  console.log(req.body.url);
  const downloadId = Date.now().toString();

  try {
    if (type === 'torrent') {
      handleTorrentDownload(url, downloadId, fileName);
    } else {
      handleDirectDownload(url, downloadId, fileName);
    }

    res.json({ downloadId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// server/server.js

async function handleDirectDownload(url, downloadId, fileName) {
  try {
    // First make a HEAD request to get content information
    const headResponse = await got.head(url);
    const totalBytes = parseInt(headResponse.headers['content-length'] || 0);
    const contentType = headResponse.headers['content-type'];

    // Initialize download state
    let downloadedBytes = 0;
    let startTime = Date.now();
    let lastUpdate = startTime;
    const UPDATE_INTERVAL = 500; // Update every 500ms

    // Create the download stream
    const downloadStream = got.stream(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    // Handle data chunks for more accurate progress
    downloadStream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      const now = Date.now();

      // Update progress every UPDATE_INTERVAL ms
      if (now - lastUpdate >= UPDATE_INTERVAL) {
        const elapsedSeconds = (now - startTime) / 1000;
        const speedBytesPerSec = downloadedBytes / elapsedSeconds;
        const progress = (downloadedBytes / totalBytes) * 100;

        io.emit(`download-progress-${downloadId}`, {
          downloadedBytes,
          totalBytes,
          progress: progress.toFixed(2),
          speed: speedBytesPerSec,
          elapsed: elapsedSeconds,
          estimated: totalBytes / speedBytesPerSec,
          status: 'downloading'
        });

        lastUpdate = now;
      }
    });

    // Prepare S3 upload parameters
    console.log(process.env.AWS_BUCKET_NAME)

    const uploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileName || url.split('/').pop(),
      Body: downloadStream,
      ContentType: contentType
    };

    // Handle potential errors during download
    downloadStream.on('error', (error) => {
      io.emit(`download-error-${downloadId}`, {
        error: `Download failed: ${error.message}`,
        status: 'error'
      });
      activeDownloads.delete(downloadId);
    });

    // Start S3 upload
    const upload = s3.upload(uploadParams);

    // Track upload progress to S3
    upload.on('httpUploadProgress', (progress) => {
      io.emit(`upload-progress-${downloadId}`, {
        uploadedBytes: progress.loaded,
        totalBytes: progress.total,
        progress: ((progress.loaded / progress.total) * 100).toFixed(2),
        status: 'uploading'
      });
    });

    // Wait for upload to complete
    const result = await upload.promise();

    // Calculate final statistics
    const totalTime = (Date.now() - startTime) / 1000;
    const averageSpeed = downloadedBytes / totalTime;

    // Emit completion event with final stats
    io.emit(`download-complete-${downloadId}`, {
      url: result.Location,
      fileName: uploadParams.Key,
      totalBytes,
      totalTime,
      averageSpeed,
      contentType,
      status: 'completed'
    });

    activeDownloads.delete(downloadId);

  } catch (error) {
    console.error('Download error:', error);
    io.emit(`download-error-${downloadId}`, {
      error: `Process failed: ${error.message}`,
      status: 'error'
    });
    activeDownloads.delete(downloadId);
  }
}

// Helper function for torrent downloads
function handleTorrentDownload(magnetUrl, downloadId, fileName) {
  client.add(magnetUrl, (torrent) => {
    const startTime = Date.now();
    let lastUpdate = startTime;
    const UPDATE_INTERVAL = 500;

    activeDownloads.set(downloadId, torrent);

    torrent.on('download', (bytes) => {
      const now = Date.now();
      if (now - lastUpdate >= UPDATE_INTERVAL) {
        const progress = (torrent.progress * 100).toFixed(2);
        const downloadedBytes = torrent.downloaded;
        const totalBytes = torrent.length;
        const speedBytesPerSec = torrent.downloadSpeed;
        const timeElapsed = (now - startTime) / 1000;

        io.emit(`download-progress-${downloadId}`, {
          downloadedBytes,
          totalBytes,
          progress,
          speed: speedBytesPerSec,
          peers: torrent.numPeers,
          elapsed: timeElapsed,
          estimated: (totalBytes - downloadedBytes) / speedBytesPerSec,
          status: 'downloading'
        });

        lastUpdate = now;
      }
    });

    torrent.on('done', () => {
      // Upload to S3 once torrent is complete
      const fileStream = torrent.files[0].createReadStream();
      console.log(process.env.AWS_BUCKET_NAME)
      const uploadParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: fileName || torrent.files[0].name,
        Body: fileStream
      };

      const upload = s3.upload(uploadParams);

      upload.on('httpUploadProgress', (progress) => {
        io.emit(`upload-progress-${downloadId}`, {
          uploadedBytes: progress.loaded,
          totalBytes: progress.total,
          progress: ((progress.loaded / progress.total) * 100).toFixed(2),
          status: 'uploading'
        });
      });

      upload.promise()
        .then(result => {
          const totalTime = (Date.now() - startTime) / 1000;
          io.emit(`download-complete-${downloadId}`, {
            url: result.Location,
            fileName: uploadParams.Key,
            totalBytes: torrent.length,
            totalTime,
            averageSpeed: torrent.length / totalTime,
            status: 'completed'
          });

          client.remove(magnetUrl);
          activeDownloads.delete(downloadId);
        })
        .catch(error => {
          io.emit(`download-error-${downloadId}`, {
            error: `Upload failed: ${error.message}`,
            status: 'error'
          });
          client.remove(magnetUrl);
          activeDownloads.delete(downloadId);
        });
    });

    torrent.on('error', (error) => {
      io.emit(`download-error-${downloadId}`, {
        error: `Torrent error: ${error.message}`,
        status: 'error'
      });
      client.remove(magnetUrl);
      activeDownloads.delete(downloadId);
    });
  });
}

// Stream endpoint for video files
app.get('/api/stream/:fileKey', async (req, res) => {
  const { range } = req.headers;
  const { fileKey } = req.params;

  if (!range) {
    res.status(400).send('Requires Range header');
    return;
  }

  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: fileKey
  };

  // Get file metadata
  const { ContentLength, ContentType } = await s3.headObject(params).promise();

  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : ContentLength - 1;
  const chunksize = (end - start) + 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${ContentLength}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunksize,
    'Content-Type': ContentType
  });

  // Stream the file chunk
  const stream = s3.getObject({
    ...params,
    Range: `bytes=${start}-${end}`
  }).createReadStream();

  stream.pipe(res);
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
});