# Smart File Uploader

A resumable, chunked file uploader implemented with a streaming Node.js/Express backend and a React frontend.
Features include 5 MB chunking, concurrent uploads, exponential-backoff retries, pause/resume via handshake, streaming writes to a pre-allocated file, SHA-256 integrity verification on finalize, and best-effort ZIP metadata inspection.

---

## Features

- 5 MB fixed-size chunking
- Concurrent uploads (3 parallel chunks)
- Retry with exponential backoff
- Pause & resume using handshake protocol
- Streaming writes to a pre-allocated file on disk
- Streaming SHA-256 file integrity verification
- Best-effort ZIP metadata inspection
- Crash-safe and idempotent backend logic

---

## Repository layout

```
smart-file-uploader/
├─ backend/
│  ├─ index.js
│  ├─ db.js
│  ├─ package.json
│  ├─ .env
│  └─ uploads/               # runtime: pre-allocated .part files are created here
├─ frontend/
│  ├─ package.json
│  ├─ src/
│  │  └─ App.js
├─ docker-compose.yml
└─ README.md
```

---

## Requirements

- Node.js v16+ and npm
- Docker Desktop (recommended) or a running MySQL 8 instance
- Modern browser for frontend (Chrome, Firefox, Edge)
- For Windows PowerShell: note that `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe` for the real curl binary or use PowerShell `Invoke-RestMethod` for API calls.

---

## Environment variables

Create `backend/.env` with values appropriate for your environment. Example:

```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=root
DB_NAME=smart_uploader
DB_PORT=3307
PORT=4000
```

- The provided `docker-compose.yml` maps container port 3306 to host port 3307 by default to avoid conflicts with a local MySQL instance. Adjust as needed.

---

## Database schema (MySQL)

Run the following SQL (database `smart_uploader`):

```sql
CREATE DATABASE IF NOT EXISTS smart_uploader;
USE smart_uploader;

CREATE TABLE uploads (
  id CHAR(36) PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  total_size BIGINT NOT NULL,
  total_chunks INT NOT NULL,
  chunk_size INT NOT NULL,
  status ENUM('UPLOADING','PROCESSING','COMPLETED','FAILED') DEFAULT 'UPLOADING',
  final_hash CHAR(64),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE chunks (
  upload_id CHAR(36),
  chunk_index INT,
  status ENUM('PENDING','RECEIVED') DEFAULT 'PENDING',
  received_at TIMESTAMP NULL,
  PRIMARY KEY (upload_id, chunk_index),
  FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
);
```

**Notes**
- `uploads` stores per-upload metadata.
- `chunks` tracks per-chunk arrival status to support resume and idempotency.

---

## Quick start with Docker

A `docker-compose.yml` is included to run a MySQL 8 instance:

```yaml
services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: smart_uploader
    ports:
      - "3307:3306"
    volumes:
      - mysql_data:/var/lib/mysql

volumes:
  mysql_data:
```

Start the database:

```bash
docker compose up -d
```

Verify container:

```bash
docker ps
```

Enter MySQL shell:

```bash
docker exec -it <mysql_container_name> mysql -uroot -proot smart_uploader
```

If `docker compose` is not available on your system, install Docker Desktop or run the MySQL container directly with `docker run` (see Troubleshooting).

---

## Backend — install and run

1. Install dependencies:

```bash
cd backend
npm install
```

Packages used in the backend implementation:
- express
- mysql2
- busboy
- uuid
- dotenv
- unzipper

2. Configure environment in `backend/.env` as described above.

3. Start the server:

```bash
node index.js
```

The server will start on port `4000` by default and expose endpoints:

- `GET /health` — health check
- `POST /api/handshake` — handshake (create or resume an upload)
- `POST /api/upload-chunk` — upload a single chunk (multipart/form-data)
- `POST /api/finalize` — finalize upload (compute SHA-256 + optional ZIP peek)

If you use Docker and want to run the backend in Docker, add a Dockerfile and connect it to the compose stack (not required for testing locally).

---

## Frontend — install and run

1. Install dependencies and start dev server:

```bash
cd frontend
npm install
npm start
```

2. Open `http://localhost:3000` in your browser. The provided `App.js` implements file picking, chunking (5 MB), handshake, chunk uploading with concurrency and retry, progress bar, and finalize call.

Cross-origin note: the backend enables CORS with permissive headers to allow the development frontend to call backend APIs. For production lock down `Access-Control-Allow-Origin` and require authentication.

---

## API specification

All endpoints are under `http://<BACKEND_HOST>:<PORT>` (default `http://localhost:4000`).

### POST /api/handshake
Start or resume an upload.

**Request body (JSON)**:
```json
{
  "filename": "myfile.zip",
  "total_size": 123456789,
  "chunk_size": 5242880
}
```

**Response (JSON)**:
```json
{
  "uploadId": "uuid-string",
  "totalChunks": 24,
  "receivedChunks": [0,1,5]
}
```

### POST /api/upload-chunk
Upload one chunk.

**Headers**:
- `upload-id`: upload UUID returned by handshake
- `chunk-index`: integer (0-based)

**Form body**:
- Field `file`: binary blob of the chunk

**Success responses**:
- `200 { "status": "uploaded" }`  
- `200 { "status": "already uploaded" }` if server already recorded the chunk

### POST /api/finalize
Finalize an upload: verify all chunks received, compute SHA-256, optionally peek top-level ZIP entries.

**Request body (JSON)**:
```json
{ "uploadId": "uuid-string" }
```

**Success response**:
```json
{
  "status": "completed",
  "sha256": "<hex-sha256>",
  "files": ["topFolder", "file1.txt"]  // may be empty if not a ZIP
}
```

If already finalized:
```json
{
  "status": "already finalized",
  "final_hash": "<hex-sha256>"
}
```

---

## Protocol & implementation notes

1. **Handshake**
   - Client POSTs file metadata.
   - Server inserts `uploads` and `chunks` rows in a transaction and pre-allocates a `.part` file on disk sized to `total_size`.
   - Server returns `uploadId` and list of already-received chunk indices.

2. **Chunk upload**
   - Client sends chunk as `multipart/form-data` with `upload-id` and `chunk-index` headers.
   - Server checks `chunks` row for idempotency, calculates `offset = chunk_index * chunk_size`, and streams the incoming chunk directly to the `.part` file using `fs.createWriteStream(..., { start: offset, flags: 'r+' })`.
   - After successful write, server updates `chunks` status to `RECEIVED`.

3. **Finalize**
   - Server obtains a row lock (`SELECT ... FOR UPDATE`) to prevent concurrent finalization.
   - Verifies all chunks are `RECEIVED`. If not, returns an error.
   - Marks `uploads.status = PROCESSING`.
   - Computes SHA-256 of the `.part` file using streaming.
   - Attempts to parse as ZIP (best-effort); on parse error returns `files: []` instead of failing finalize.
   - Updates `uploads.status = COMPLETED` and saves `final_hash`.

---

## Client-side design (frontend)

- Chunk size: 5 MB.
- Concurrency: 3 parallel chunk uploads.
- Retry: exponential backoff with configurable `MAX_RETRIES`.
- Pause & Resume: client calls handshake before uploading; server returns already-received chunk indices, and client uploads only pending chunks.
- Backend streaming writes (no full file buffering)
- Progress: derived from number of completed chunks and their sizes; UI reflects per-chunk status and overall percent.
- React UI with:
  - Progress bar
  - Upload speed (MB/s)
  - ETA
  - Chunk grid with status indicators

---

## Testing & demo checklist

Run these scenarios and capture results:

1. **Normal upload**: upload a file of moderate size and verify `uploads` and `chunks` tables, `.part` file, and finalize SHA-256.
2. **Resume after refresh**: start upload, refresh the browser, re-run the same upload flow — only pending chunks should be uploaded.
3. **Server restart**: start upload, kill backend process mid-upload, restart backend, resume upload — server should accept pending chunks only.
4. **Network throttling / offline**: use browser devtools to simulate poor network; client should retry failed chunks.
5. **Duplicate finalize**: call `/api/finalize` multiple times; second call should report `already finalized`.

Useful test commands (PowerShell):

Handshake (PowerShell):
```powershell
Invoke-RestMethod -Uri http://localhost:4000/api/handshake -Method POST -ContentType "application/json" -Body '{"filename":"test.zip","total_size":10485760,"chunk_size":5242880}'
```

Upload chunk (PowerShell / curl.exe):
```powershell
curl.exe -X POST http://localhost:4000/api/upload-chunk -H "upload-id: <UPLOAD_ID>" -H "chunk-index: 0" -F "file=@chunk0.bin"
```

Finalize (PowerShell):
```powershell
Invoke-RestMethod -Uri http://localhost:4000/api/finalize -Method POST -ContentType "application/json" -Body '{"uploadId":"<UPLOAD_ID>"}'
```

---

## Failure modes and handling

- **Duplicate chunk uploads**: server checks `chunks` table and replies `already uploaded` if chunk is present.
- **Out-of-order delivery**: file is pre-allocated and chunk bytes are written at calculated offsets; order does not matter.
- **Partial writes**: server only marks `RECEIVED` after write completes; incomplete chunk will be retried by client on resume.
- **Non-ZIP files**: ZIP inspection is best-effort; non-ZIP results simply produce an empty `files` array.
- **Double-finalize**: handled by row-locking and state checks.

---

## File Integrity Handling (Hashing)

File integrity is ensured using **SHA-256 hashing** on the backend during the finalization step.

- The server computes the hash using Node.js streams (`crypto.createHash('sha256')`).
- The entire file is **never loaded into memory**; instead, it is streamed from disk.
- Hashing occurs **only after all chunks have been successfully received**.
- The computed SHA-256 hash is:
  - Returned to the client
  - Persisted in the `uploads.final_hash` column in the database

This guarantees that the reconstructed file exactly matches the original uploaded content.

---

## Pause & Resume Logic

Pause and resume functionality is implemented using a **handshake-based protocol** combined with persistent chunk metadata stored in MySQL.

### How it works:

1. Before uploading, the client sends a `POST /api/handshake` request containing:
   - Filename
   - Total file size
   - Chunk size

2. The server:
   - Creates (or resumes) an upload entry
   - Returns an `uploadId`
   - Returns a list of already received chunk indices (`receivedChunks`)

3. The client:
   - Slices the file into chunks
   - Skips uploading chunks already marked as received
   - Uploads only pending chunks

### Benefits:

- Upload can resume after:
  - Browser refresh
  - Network disconnection
  - Backend crash or restart
- Resume works even across sessions, because state is stored in the database
- No duplicate data is written due to idempotent chunk handling

---

## Known Trade-offs

The following trade-offs were made to balance complexity, performance, and clarity:

- **No per-chunk checksums**  
  Chunk integrity is inferred from successful write completion rather than per-chunk hashing.

- **No authentication or user accounts**  
  The system assumes a trusted environment, as authentication was outside the assignment scope.

- **Single-node storage**  
  Uploaded files are stored on local disk rather than distributed object storage (e.g., S3).

- **Best-effort ZIP inspection**  
  ZIP metadata inspection is optional and non-fatal; invalid ZIPs do not block upload completion.

- **Development-focused CORS policy**  
  CORS is permissive for local development and should be restricted in production.

---

## Further Enhancements

Several improvements can be made beyond the current implementation:

- Add per-chunk checksums for stronger corruption detection
- Support pause/resume buttons in the UI
- Store uploads in cloud object storage (e.g., S3 multipart upload)
- Add authentication and per-user upload quotas
- Implement upload expiration and background cleanup jobs
- Support resumable uploads across multiple backend instances
- Improve frontend UX with speed (MB/s) and ETA indicators
- Add automated tests for backend APIs

---

## Summary

This project implements a robust, resumable file upload system using:

- Streaming I/O for scalability
- Database-backed state for fault tolerance
- Concurrency and retries for performance and reliability
- Strong file integrity guarantees via SHA-256 hashing

The design emphasizes correctness, resumability, and resilience to failures.

---
