const path = require('path');
const fs = require('fs');

const UPLOADS_DIR = path.join(__dirname, '../uploads');

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

function getUploadPath(filename) {
  ensureUploadsDir();
  return path.join(UPLOADS_DIR, filename);
}

function deleteUploadedFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error('Failed to delete uploaded file:', err);
  }
}

function getPublicImagePath(filename) {
  return `/uploads/${filename}`;
}

module.exports = { getUploadPath, deleteUploadedFile, getPublicImagePath, UPLOADS_DIR };
