const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const mongo = require("../utils/mongoClient");

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, "../uploads/agenda");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, "agenda-" + uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['.pdf', '.doc', '.docx', '.pptx', '.xlsx'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF, DOC, DOCX, PPTX, XLSX files are allowed'));
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: fileFilter
});

async function obtainDb() {
  try {
    if (!mongo) return null;
    if (typeof mongo.getDb === "function") return await mongo.getDb();
    if (mongo.db) return mongo.db;
    return null;
  } catch {
    return null;
  }
}

// GET - Fetch agenda details
router.get("/", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) {
      return res.status(500).json({ success: false, error: "Database not ready" });
    }

    const agenda = await db.collection("agenda").findOne({ type: "program_agenda" });
    
    if (!agenda) {
      return res.json({ 
        success: true, 
        data: { 
          title: "Program Agenda", 
          description: "Download the program agenda for 6th RailTrans Expo 2026",
          fileUrl: null,
          fileName: null,
          fileSize: null,
          updatedAt: null
        } 
      });
    }

    // Generate download URL
    const baseUrl = process.env.BASE_URL || req.protocol + '://' + req.get('host');
    const fileUrl = agenda.filePath ? `${baseUrl}/uploads/agenda/${path.basename(agenda.filePath)}` : null;

    return res.json({
      success: true,
      data: {
        title: agenda.title || "Program Agenda",
        description: agenda.description || "Download the program agenda for 6th RailTrans Expo 2026",
        fileUrl: fileUrl,
        fileName: agenda.fileName,
        fileSize: agenda.fileSize,
        updatedAt: agenda.updatedAt,
        fileId: agenda.fileId
      }
    });
  } catch (error) {
    console.error("[agenda] GET error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST - Upload agenda file
router.post("/upload", upload.single("agendaFile"), async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) {
      return res.status(500).json({ success: false, error: "Database not ready" });
    }

    const { title, description } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    // Get file stats
    const stats = fs.statSync(file.path);

    // Save to database
    const agendaData = {
      type: "program_agenda",
      title: title || "Program Agenda",
      description: description || "Download the program agenda for 6th RailTrans Expo 2026",
      filePath: file.path,
      fileName: file.originalname,
      fileSize: stats.size,
      fileId: file.filename,
      updatedAt: new Date(),
      createdAt: new Date()
    };

    await db.collection("agenda").updateOne(
      { type: "program_agenda" },
      { $set: agendaData },
      { upsert: true }
    );

    // Generate download URL
    const baseUrl = process.env.BASE_URL || req.protocol + '://' + req.get('host');
    const fileUrl = `${baseUrl}/uploads/agenda/${file.filename}`;

    return res.json({
      success: true,
      message: "Agenda uploaded successfully",
      data: {
        fileUrl: fileUrl,
        fileName: file.originalname,
        fileSize: stats.size,
        title: title || "Program Agenda",
        description: description || "Download the program agenda for 6th RailTrans Expo 2026"
      }
    });
  } catch (error) {
    console.error("[agenda] Upload error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE - Remove agenda file
router.delete("/", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) {
      return res.status(500).json({ success: false, error: "Database not ready" });
    }

    const agenda = await db.collection("agenda").findOne({ type: "program_agenda" });
    
    if (agenda && agenda.filePath) {
      // Delete file from disk
      try {
        if (fs.existsSync(agenda.filePath)) {
          fs.unlinkSync(agenda.filePath);
        }
      } catch (e) {
        console.error("Error deleting file:", e);
      }
    }

    await db.collection("agenda").deleteOne({ type: "program_agenda" });

    return res.json({
      success: true,
      message: "Agenda deleted successfully"
    });
  } catch (error) {
    console.error("[agenda] DELETE error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET - Serve file for download
router.get("/download", async (req, res) => {
  try {
    const db = await obtainDb();
    if (!db) {
      return res.status(500).json({ success: false, error: "Database not ready" });
    }

    const agenda = await db.collection("agenda").findOne({ type: "program_agenda" });
    
    if (!agenda || !agenda.filePath) {
      return res.status(404).json({ success: false, error: "Agenda file not found" });
    }

    if (!fs.existsSync(agenda.filePath)) {
      return res.status(404).json({ success: false, error: "File not found on server" });
    }

    res.download(agenda.filePath, agenda.fileName);
  } catch (error) {
    console.error("[agenda] Download error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;