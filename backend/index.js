const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const crypto = require('crypto');
const unzipper = require('unzipper');

const app = express();
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  next();
});

// HANDSHAKE API
app.post('/api/handshake', async (req, res) => {
  const { filename, total_size, chunk_size } = req.body;

  if (!filename || !total_size || !chunk_size) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const uploadId = uuidv4();
  const totalChunks = Math.ceil(total_size / chunk_size);
  const filePath = path.join(UPLOAD_DIR, uploadId + '.part');

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    await connection.execute(
      `INSERT INTO uploads (id, filename, total_size, total_chunks, chunk_size)
       VALUES (?, ?, ?, ?, ?)`,
      [uploadId, filename, total_size, totalChunks, chunk_size]
    );

    for (let i = 0; i < totalChunks; i++) {
      await connection.execute(
        `INSERT INTO chunks (upload_id, chunk_index)
         VALUES (?, ?)`,
        [uploadId, i]
      );
    }

    const fd = fs.openSync(filePath, 'w');
    fs.ftruncateSync(fd, total_size);
    fs.closeSync(fd);

    await connection.commit();

    res.json({
      uploadId,
      totalChunks,
      receivedChunks: []
    });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: 'Handshake failed' });
  } finally {
    connection.release();
  }
});

// UPLOAD CHUNK API
const busboy = require('busboy');

app.post('/api/upload-chunk', async (req, res) => {
  const uploadId = req.headers['upload-id'];
  const chunkIndex = parseInt(req.headers['chunk-index'], 10);

  if (!uploadId || isNaN(chunkIndex)) {
    return res.status(400).json({ error: 'Missing upload-id or chunk-index' });
  }

  const connection = await db.getConnection();

  try {
    const [rows] = await connection.execute(
      'SELECT status FROM chunks WHERE upload_id = ? AND chunk_index = ?',
      [uploadId, chunkIndex]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Unknown chunk' });
    }

    if (rows[0].status === 'RECEIVED') {
      return res.json({ status: 'already uploaded' });
    }

    const [[upload]] = await connection.execute(
      'SELECT chunk_size FROM uploads WHERE id = ?',
      [uploadId]
    );

    const chunkSize = upload.chunk_size;
    const offset = chunkIndex * chunkSize;
    const filePath = path.join(UPLOAD_DIR, uploadId + '.part');

    const bb = busboy({ headers: req.headers });

    let writePromise;

    bb.on('file', (_, fileStream) => {
      const writeStream = fs.createWriteStream(filePath, {
        flags: 'r+',
        start: offset,
      });

      writePromise = new Promise((resolve, reject) => {
        fileStream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        fileStream.on('error', reject);
      });
    });

    bb.on('finish', async () => {
      await writePromise;

      await connection.execute(
        'UPDATE chunks SET status = "RECEIVED", received_at = NOW() WHERE upload_id = ? AND chunk_index = ?',
        [uploadId, chunkIndex]
      );

      res.json({ status: 'uploaded' });
    });

    req.pipe(bb);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Chunk upload failed' });
  } finally {
    connection.release();
  }
});

app.listen(4000, () => {
  console.log('Backend running on http://localhost:4000');
});

// PEEKING ZIP FILES
function computeSHA256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function peekZipTopLevel(filePath) {
  const files = new Set();

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath);

    stream
      .pipe(unzipper.Parse())
      .on('entry', entry => {
        const topLevel = entry.path.split('/')[0];
        files.add(topLevel);
        entry.autodrain();
      })
      .on('close', () => resolve([...files]))
      .on('error', () => {
        resolve([]);
      });
  });
}


// FINALIZE API
app.post('/api/finalize', async (req, res) => {
  const { uploadId } = req.body;

  if (!uploadId) {
    return res.status(400).json({ error: 'Missing uploadId' });
  }

  const connection = await db.getConnection();
  const filePath = path.join(UPLOAD_DIR, uploadId + '.part');

  try {
    await connection.beginTransaction();

    const [[upload]] = await connection.execute(
      'SELECT * FROM uploads WHERE id = ? FOR UPDATE',
      [uploadId]
    );

    if (!upload) {
      await connection.rollback();
      return res.status(404).json({ error: 'Upload not found' });
    }

    if (upload.status === 'COMPLETED') {
      await connection.rollback();
      return res.json({
        status: 'already finalized',
        final_hash: upload.final_hash,
      });
    }

    const [[missing]] = await connection.execute(
      'SELECT COUNT(*) AS count FROM chunks WHERE upload_id = ? AND status != "RECEIVED"',
      [uploadId]
    );

    if (missing.count > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Missing chunks' });
    }

    await connection.execute(
      'UPDATE uploads SET status = "PROCESSING" WHERE id = ?',
      [uploadId]
    );

    await connection.commit();

    const hash = await computeSHA256(filePath);

    const files = await peekZipTopLevel(filePath);

    await connection.execute(
      'UPDATE uploads SET status = "COMPLETED", final_hash = ? WHERE id = ?',
      [hash, uploadId]
    );

    res.json({
      status: 'completed',
      sha256: hash,
      files,
    });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: 'Finalize failed' });
  } finally {
    connection.release();
  }
});
